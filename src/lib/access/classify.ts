/**
 * Who fetched a proof?
 *
 * The whole premise of Letterprove is that AI agents evaluating a product will
 * go and read the evidence. That is a testable claim, and this is the
 * instrument that tests it: every proof request is classified by requester, so
 * "did ChatGPT actually fetch this" is a query rather than a hope.
 *
 * Classification is by user-agent alone. A user-agent is self-reported and
 * trivially forgeable, so this is an observation about what a requester CLAIMS
 * to be — good enough for "is anything reading our proofs", not evidence of
 * anything, and never fed into an attestation.
 *
 * Order matters in the table below. `Google-Extended` and `Applebot-Extended`
 * are AI-training/answer agents and must be matched before the bare
 * `Googlebot` / `Applebot` search crawlers they share a prefix with.
 */

export type RequesterKind = "ai_agent" | "search_crawler" | "browser" | "unknown";

export interface Requester {
	kind: RequesterKind;
	/** Canonical short name, or "" when unrecognised. */
	name: string;
}

const TABLE: [match: string, kind: RequesterKind, name: string][] = [
	// AI answer engines and their fetchers. Two per vendor is normal: one
	// crawls for the index, one fetches live when a user asks something.
	["chatgpt-user", "ai_agent", "chatgpt"],
	["oai-searchbot", "ai_agent", "chatgpt"],
	["gptbot", "ai_agent", "chatgpt"],
	["claude-user", "ai_agent", "claude"],
	["claude-searchbot", "ai_agent", "claude"],
	["claudebot", "ai_agent", "claude"],
	["anthropic-ai", "ai_agent", "claude"],
	["perplexity-user", "ai_agent", "perplexity"],
	["perplexitybot", "ai_agent", "perplexity"],
	["google-extended", "ai_agent", "gemini"],
	["meta-externalagent", "ai_agent", "meta"],
	["applebot-extended", "ai_agent", "apple"],
	["mistralai-user", "ai_agent", "mistral"],
	["cohere-ai", "ai_agent", "cohere"],
	["bytespider", "ai_agent", "bytedance"],
	["ccbot", "ai_agent", "commoncrawl"],
	["diffbot", "ai_agent", "diffbot"],
	["youbot", "ai_agent", "you"],

	// Search crawlers — a different question (indexing) from the one above.
	["googlebot", "search_crawler", "google"],
	["bingbot", "search_crawler", "bing"],
	["duckduckbot", "search_crawler", "duckduckgo"],
	["yandexbot", "search_crawler", "yandex"],
	["baiduspider", "search_crawler", "baidu"],
	["applebot", "search_crawler", "apple"],
	["slurp", "search_crawler", "yahoo"],
];

export function classify(userAgent: string | null): Requester {
	if (!userAgent) return { kind: "unknown", name: "" };
	const ua = userAgent.toLowerCase();

	for (const [match, kind, name] of TABLE) {
		if (ua.includes(match)) return { kind, name };
	}

	// Anything left claiming to be a browser engine. Plenty of scripts send a
	// browser user-agent, so this bucket is "not a self-identified bot" rather
	// than "a person" — the distinction the phantom-access work learned the
	// hard way, and the reason nothing here is called `human`.
	if (ua.includes("mozilla/") && /(chrome|safari|firefox|edg)\//.test(ua)) {
		return { kind: "browser", name: "" };
	}

	return { kind: "unknown", name: "" };
}
