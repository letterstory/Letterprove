#!/usr/bin/env node
/**
 * Does published proof change what an evaluating agent recommends?
 *
 * That question is the premise of the entire product, and it is testable. This
 * runs the test: the same buying decision, put to the same model twice, where
 * the only difference is whether the target vendor offers verifiable
 * attestations or an equally-long unverifiable testimonial.
 *
 *   node experiments/aeo/run.mjs --base https://letterprove.example.com
 *   node experiments/aeo/run.mjs --base http://x --dry-run   # print, don't call
 *
 * THE MEASUREMENT THAT MATTERS IS NOT THE MODEL'S OPINION.
 *
 * Asking a model whether proof influenced it produces a plausible answer with
 * no evidential value. So the primary signal here is behavioural and recorded
 * from the API response, not self-reported: did the model actually issue a
 * web_fetch against the proof endpoint? A fetch is a fact about what happened.
 * The ranking it produces afterwards is the secondary signal.
 *
 * The proof endpoints log every fetch and classify the requester
 * (src/lib/access/), so a live deployment gives the same fact from the other
 * side — server-side confirmation that is not mediated by anything the model
 * reports about itself.
 *
 * A NEGATIVE RESULT IS A RESULT. If agents never fetch the proof, or fetch it
 * and rank the same either way, that is the most valuable thing this repo can
 * learn, and it is cheaper to learn now than after building the collector.
 * Report it as found.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------- config

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const BASE = flag("base");
const MODEL = flag("model", "claude-opus-5");
const ROUNDS = Number(flag("rounds", "1"));
const ARMS = (flag("arms", "proof,control") ?? "").split(",");
const OUT = flag("out", join(HERE, "results.jsonl"));
const DRY = has("dry-run");

if (!BASE) {
	console.error(`
  usage: node experiments/aeo/run.mjs --base <public-letterprove-url> [options]

    --base <url>      REQUIRED. Must be publicly reachable — the web_fetch tool
                      runs on Anthropic's servers, so localhost cannot be read.
    --model <id>      default claude-opus-5
    --rounds <n>      repeats per prompt/arm (default 1). Model output varies;
                      one round per cell is an anecdote, not a measurement.
    --arms <list>     default proof,control
    --out <path>      JSONL results (default experiments/aeo/results.jsonl)
    --dry-run         print the requests and exit without calling the API
`);
	process.exit(2);
}

const scenario = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8"));
const PROOF_URL = `${BASE.replace(/\/$/, "")}${scenario.proof_path}`;

// -------------------------------------------------------------- the request

/**
 * One arm's brief.
 *
 * Both arms give the target vendor the same number of extra words — the proof
 * arm gets a verifiable endpoint, the control gets a testimonial. Without that
 * balance the experiment would measure "longer entry wins", which is a
 * different and much less interesting finding.
 */
function brief(prompt, arm) {
	const lines = scenario.candidates.map((c) => {
		const extra = c.target
			? arm === "proof"
				? c.proof.replace("{PROOF_URL}", PROOF_URL)
				: c.control
			: c.control;
		return `- ${c.name}: ${c.claims} ${extra}`;
	});

	return [
		prompt,
		"",
		`Candidates (${scenario.category}):`,
		...lines,
		"",
		"Use your tools to check anything you can. End your reply with exactly one line:",
		'<verdict>{"ranking":["<name>", ...best to worst],"recommended":"<name>","confidence":"high|medium|low","evidence":["<what you actually relied on>"]}</verdict>',
	].join("\n");
}

const TOOLS = [
	{ type: "web_search_20260209", name: "web_search", max_uses: 5 },
	{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
];

// ------------------------------------------------------------------ the run

const client = new Anthropic();

/**
 * Run one cell to completion.
 *
 * Server-side tools run in a loop on Anthropic's side and stop with
 * `pause_turn` when that loop hits its iteration cap. Resuming is just
 * re-sending with the assistant turn appended — no extra user message, which
 * would be read as a new instruction.
 */
async function ask(content) {
	const messages = [{ role: "user", content }];
	const blocks = [];
	let usage = { input_tokens: 0, output_tokens: 0 };
	let stop = null;
	let useFallbacks = true;

	for (let turn = 0; turn < 6; turn++) {
		let response;
		try {
			response = await client.beta.messages.create({
				model: MODEL,
				max_tokens: 16000,
				tools: TOOLS,
				messages,
				// Claude Opus 5's safety classifiers can decline a request; this
				// re-runs a decline on Anthropic's recommended fallback rather than
				// returning an empty answer that would look like a null result.
				...(useFallbacks && {
					betas: ["server-side-fallback-2026-07-01"],
					fallbacks: "default",
				}),
			});
		} catch (e) {
			// Don't let an un-enabled beta take the whole experiment down — the
			// fallback is a nicety, the measurement is the point.
			if (useFallbacks && e?.status === 400 && /fallback|beta/i.test(e?.message ?? "")) {
				console.warn("  (fallbacks unavailable on this account — continuing without)");
				useFallbacks = false;
				continue;
			}
			throw e;
		}

		blocks.push(...response.content);
		usage = {
			input_tokens: usage.input_tokens + (response.usage?.input_tokens ?? 0),
			output_tokens: usage.output_tokens + (response.usage?.output_tokens ?? 0),
		};
		stop = response.stop_reason;

		if (stop !== "pause_turn") break;
		messages.push({ role: "assistant", content: response.content });
	}

	return { blocks, usage, stop };
}

/** What the model DID, read off the response rather than asked about. */
function signals(blocks) {
	const toolCalls = blocks
		.filter((b) => b.type === "server_tool_use")
		.map((b) => ({ name: b.name, url: b.input?.url ?? "", query: b.input?.query ?? "" }));

	const text = blocks
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");

	let verdict = null;
	const match = text.match(/<verdict>([\s\S]*?)<\/verdict>/);
	if (match) {
		try {
			verdict = JSON.parse(match[1].trim());
		} catch {
			/* leave null; raw text is recorded either way */
		}
	}

	const ranking = Array.isArray(verdict?.ranking) ? verdict.ranking : [];
	const rankIndex = ranking.findIndex((n) => String(n).toLowerCase().includes(scenario.target.toLowerCase()));

	return {
		fetched_proof: toolCalls.some((c) => c.name === "web_fetch" && c.url.startsWith(BASE)),
		web_fetches: toolCalls.filter((c) => c.name === "web_fetch").length,
		web_searches: toolCalls.filter((c) => c.name === "web_search").length,
		cited_proof: text.includes(PROOF_URL),
		recommended_target:
			String(verdict?.recommended ?? "").toLowerCase().includes(scenario.target.toLowerCase()),
		// 1-based; null when the model didn't rank, so it never silently
		// averages in as a good or bad position.
		target_rank: rankIndex >= 0 ? rankIndex + 1 : null,
		confidence: verdict?.confidence ?? null,
		tool_calls: toolCalls,
		verdict,
		text,
	};
}

// ------------------------------------------------------------------- driver

const cells = [];
for (const arm of ARMS) {
	for (const [p, prompt] of scenario.prompts.entries()) {
		for (let round = 0; round < ROUNDS; round++) {
			cells.push({ arm, promptIndex: p, round, content: brief(prompt, arm) });
		}
	}
}

if (DRY) {
	console.log(`\n  DRY RUN — ${cells.length} cells, model ${MODEL}, no API calls\n`);
	// One sample per arm on the same prompt — the arms are only comparable if
	// you can read the difference between them, so show exactly that.
	const samples = ARMS.map((arm) => cells.find((c) => c.arm === arm && c.promptIndex === 0)).filter(Boolean);
	for (const cell of samples) {
		console.log(`  ── arm=${cell.arm} prompt=${cell.promptIndex} ${"─".repeat(40)}`);
		console.log(cell.content.replace(/^/gm, "  "));
		console.log();
	}
	console.log(`  tools: ${TOOLS.map((t) => t.name).join(", ")}`);
	console.log(`  proof url: ${PROOF_URL}\n`);
	process.exit(0);
}

console.log(`\n  ${cells.length} cells · model ${MODEL} · proof at ${PROOF_URL}\n`);

const results = [];
for (const cell of cells) {
	const label = `arm=${cell.arm} prompt=${cell.promptIndex} round=${cell.round}`;
	try {
		const { blocks, usage, stop } = await ask(cell.content);

		if (stop === "refusal") {
			console.log(`  ⚠ ${label} — refused`);
			results.push({ ...cell, content: undefined, stop, refused: true });
			continue;
		}

		const s = signals(blocks);
		const row = { ...cell, content: undefined, stop, usage, ...s };
		results.push(row);
		appendFileSync(OUT, JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n");

		console.log(
			`  ${s.fetched_proof ? "✓" : "·"} ${label}` +
				`  rank=${s.target_rank ?? "?"}` +
				`  rec=${s.recommended_target ? "yes" : "no"}` +
				`  fetch=${s.web_fetches} search=${s.web_searches}`
		);
	} catch (e) {
		console.log(`  ✗ ${label} — ${e.message}`);
		results.push({ ...cell, content: undefined, error: e.message });
	}
}

// ------------------------------------------------------------------ summary

const usable = results.filter((r) => !r.error && !r.refused);
console.log(`\n  ${"arm".padEnd(10)}${"n".padEnd(5)}${"fetched".padEnd(10)}${"mean rank".padEnd(12)}recommended`);
console.log(`  ${"─".repeat(52)}`);

for (const arm of ARMS) {
	const rows = usable.filter((r) => r.arm === arm);
	if (!rows.length) continue;
	const ranked = rows.filter((r) => r.target_rank !== null);
	const mean = ranked.length
		? (ranked.reduce((n, r) => n + r.target_rank, 0) / ranked.length).toFixed(2)
		: "—";
	const pct = (n) => `${Math.round((100 * n) / rows.length)}%`;

	console.log(
		`  ${arm.padEnd(10)}${String(rows.length).padEnd(5)}` +
			`${pct(rows.filter((r) => r.fetched_proof).length).padEnd(10)}` +
			`${String(mean).padEnd(12)}${pct(rows.filter((r) => r.recommended_target).length)}`
	);
}

const spent = usable.reduce((n, r) => n + (r.usage?.output_tokens ?? 0), 0);
console.log(`\n  ${usable.length}/${results.length} usable · ${spent.toLocaleString("en-US")} output tokens · → ${OUT}`);
console.log(
	`\n  Mean rank is over cells that produced a parseable ranking only. With a\n` +
		`  handful of rounds this is directional, not significant — say so when you\n` +
		`  report it, and check the server-side access log for the other half of\n` +
		`  the picture.\n`
);
