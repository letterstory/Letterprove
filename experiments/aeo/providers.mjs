/**
 * One question, four answer engines.
 *
 * Each adapter takes the same brief and returns the same shape, so the runner
 * never branches on which engine it is talking to:
 *
 *   { text, calls: [{ kind: "fetch"|"search"|"code", url, query }], usage, stop, model }
 *
 * `calls` is read off the API response — what the engine DID, not what it says
 * it did. Every engine gets the closest thing it has to the consumer product's
 * tools: web search, page fetch, and code execution where the API offers them.
 * Where it does not (Perplexity has no fetch and no code), that absence is part
 * of the result, not something to paper over: an engine that cannot fetch a
 * proof cannot be swayed by one it has not indexed.
 *
 * Keys come from the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GEMINI_API_KEY, PERPLEXITY_API_KEY). An engine whose key is missing is
 * reported as unavailable rather than silently skipped.
 */

import Anthropic from "@anthropic-ai/sdk";

const TIMEOUT_MS = 10 * 60 * 1000;

export const DEFAULT_MODELS = {
	claude: "claude-opus-5-5",
	chatgpt: "gpt-6.1-sol",
	gemini: "gemini-pro-latest",
	perplexity: "sonar-pro",
};

const KEY_ENV = {
	claude: "ANTHROPIC_API_KEY",
	chatgpt: "OPENAI_API_KEY",
	gemini: "GEMINI_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
};

/** Which engines can actually run here — the Anthropic SDK also resolves an `ant auth login` profile. */
export function available(engine) {
	return engine === "claude" || Boolean(process.env[KEY_ENV[engine]]);
}

export function adapter(engine, model = DEFAULT_MODELS[engine]) {
	const ask = { claude: askClaude, chatgpt: askChatGPT, gemini: askGemini, perplexity: askPerplexity }[engine];
	if (!ask) throw new Error(`unknown engine "${engine}" — expected one of ${Object.keys(DEFAULT_MODELS).join(", ")}`);
	return (content) => withRetry(() => ask(content, model));
}

/** 429 / 5xx / network are retried with backoff; anything else is a real answer about the request. */
async function withRetry(fn, attempts = 4) {
	for (let i = 0; ; i++) {
		try {
			return await fn();
		} catch (e) {
			const status = e?.status ?? 0;
			const retryable = status === 429 || status >= 500 || status === 0;
			if (!retryable || i >= attempts - 1) throw e;
			await new Promise((r) => setTimeout(r, 2 ** i * 5000));
		}
	}
}

async function postJson(url, headers, body) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(`${res.status} ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
		err.status = res.status;
		throw err;
	}
	return json;
}

// ------------------------------------------------------------------- Claude

let anthropic = null;

/**
 * web_search + web_fetch (the _20260209 variants run code execution under the
 * hood for dynamic filtering, so code_execution is NOT declared separately).
 * Server tools loop on Anthropic's side and stop with `pause_turn` at their
 * iteration cap; resuming is re-sending with the assistant turn appended.
 */
async function askClaude(content, model) {
	anthropic ??= new Anthropic();
	const messages = [{ role: "user", content }];
	const blocks = [];
	const usage = { input_tokens: 0, output_tokens: 0 };
	let stop = null;
	let servedBy = model;

	for (let turn = 0; turn < 8; turn++) {
		const response = await anthropic.beta.messages.create(
			{
				model,
				max_tokens: 16000,
				tools: [
					{ type: "web_search_20260209", name: "web_search", max_uses: 8 },
					{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
				],
				messages,
				// A safety-classifier decline re-runs on the recommended fallback
				// rather than coming back empty and reading as a null result.
				betas: ["server-side-fallback-2026-07-01"],
				fallbacks: "default",
			},
			{ timeout: TIMEOUT_MS }
		);
		blocks.push(...response.content);
		usage.input_tokens += response.usage?.input_tokens ?? 0;
		usage.output_tokens += response.usage?.output_tokens ?? 0;
		servedBy = response.model ?? servedBy;
		stop = response.stop_reason;
		if (stop !== "pause_turn") break;
		messages.push({ role: "assistant", content: response.content });
	}

	const calls = blocks
		.filter((b) => b.type === "server_tool_use")
		.map((b) => ({
			kind: b.name === "web_fetch" ? "fetch" : b.name === "web_search" ? "search" : "code",
			url: b.input?.url ?? "",
			query: b.input?.query ?? "",
		}));
	const text = blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");

	return { text, calls, usage, stop: stop === "refusal" ? "refusal" : "end", model: servedBy };
}

// ------------------------------------------------------------------ ChatGPT

/**
 * Responses API with the hosted web_search tool (which also opens pages —
 * `action.type === "open_page"`) and code_interpreter: the same two
 * capabilities ChatGPT itself has.
 */
async function askChatGPT(content, model) {
	const r = await postJson(
		"https://api.openai.com/v1/responses",
		{ authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
		{
			model,
			input: content,
			tools: [{ type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }],
		}
	);

	const calls = [];
	const texts = [];
	for (const item of r.output ?? []) {
		if (item.type === "web_search_call") {
			const a = item.action ?? {};
			if (a.type === "open_page" || a.type === "find_in_page") calls.push({ kind: "fetch", url: a.url ?? "", query: "" });
			else calls.push({ kind: "search", url: "", query: a.query ?? (a.queries ?? []).join(" | ") });
		} else if (item.type === "code_interpreter_call") {
			calls.push({ kind: "code", url: "", query: "" });
		} else if (item.type === "message") {
			for (const c of item.content ?? []) if (c.type === "output_text") texts.push(c.text);
		}
	}

	const refused = (r.output ?? []).some((i) => i.type === "message" && i.content?.some((c) => c.type === "refusal"));
	return {
		text: texts.join("\n"),
		calls,
		usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 },
		stop: refused ? "refusal" : "end",
		model: r.model ?? model,
	};
}

// ------------------------------------------------------------------- Gemini

/** google_search + url_context (page fetch) + code_execution, all server-side in one call. */
async function askGemini(content, model) {
	const r = await postJson(
		`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
		{ "x-goog-api-key": process.env.GEMINI_API_KEY },
		{
			contents: [{ role: "user", parts: [{ text: content }] }],
			tools: [{ google_search: {} }, { url_context: {} }, { code_execution: {} }],
		}
	);

	const cand = r.candidates?.[0] ?? {};
	const parts = cand.content?.parts ?? [];
	const calls = [
		...(cand.groundingMetadata?.webSearchQueries ?? []).map((q) => ({ kind: "search", url: "", query: q })),
		...(cand.urlContextMetadata?.urlMetadata ?? []).map((m) => ({
			kind: "fetch",
			url: m.retrievedUrl ?? "",
			query: "",
			status: m.urlRetrievalStatus,
		})),
		...parts.filter((p) => p.executableCode).map(() => ({ kind: "code", url: "", query: "" })),
	];

	return {
		text: parts
			.filter((p) => typeof p.text === "string" && !p.thought)
			.map((p) => p.text)
			.join("\n"),
		calls,
		usage: {
			input_tokens: (r.usageMetadata?.promptTokenCount ?? 0) + (r.usageMetadata?.toolUsePromptTokenCount ?? 0),
			output_tokens: (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0),
		},
		stop: cand.finishReason === "SAFETY" || r.promptFeedback?.blockReason ? "refusal" : "end",
		model: r.modelVersion ?? model,
	};
}

// --------------------------------------------------------------- Perplexity

/**
 * Sonar searches its own index on every request. It cannot fetch an arbitrary
 * URL and has no code tool, so a proof it has not indexed is invisible to it —
 * the calls list records only the search results it grounded on.
 */
async function askPerplexity(content, model) {
	const r = await postJson(
		"https://api.perplexity.ai/chat/completions",
		{ authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
		{ model, messages: [{ role: "user", content }] }
	);
	return {
		text: r.choices?.[0]?.message?.content ?? "",
		calls: (r.search_results ?? []).map((s) => ({ kind: "search", url: s.url ?? "", query: "" })),
		usage: { input_tokens: r.usage?.prompt_tokens ?? 0, output_tokens: r.usage?.completion_tokens ?? 0 },
		stop: "end",
		model: r.model ?? model,
	};
}
