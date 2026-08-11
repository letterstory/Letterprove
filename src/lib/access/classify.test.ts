import { describe, expect, it } from "vitest";
import { classify } from "./classify";

describe("classify", () => {
	it("names the AI agents the product exists for", () => {
		expect(classify("Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)")).toEqual({
			kind: "ai_agent",
			name: "chatgpt",
		});
		expect(classify("Mozilla/5.0 (compatible; PerplexityBot/1.0)")).toMatchObject({ name: "perplexity" });
		expect(classify("Claude-User/1.0")).toMatchObject({ kind: "ai_agent", name: "claude" });
	});

	it("separates the AI variant from the search crawler that shares its prefix", () => {
		// The distinction that matters and the one a naive substring match gets
		// wrong: Google-Extended is the AI agent, Googlebot is the indexer.
		expect(classify("Mozilla/5.0 (compatible; Google-Extended/1.0)")).toEqual({
			kind: "ai_agent",
			name: "gemini",
		});
		expect(classify("Mozilla/5.0 (compatible; Googlebot/2.1)")).toEqual({
			kind: "search_crawler",
			name: "google",
		});
		expect(classify("Mozilla/5.0 (compatible; Applebot-Extended/1.0)")).toMatchObject({ kind: "ai_agent" });
		expect(classify("Mozilla/5.0 (compatible; Applebot/0.1)")).toMatchObject({ kind: "search_crawler" });
	});

	it("treats a plain browser string as browser, not as a person", () => {
		const chrome =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
		expect(classify(chrome)).toEqual({ kind: "browser", name: "" });
	});

	it("falls through to unknown rather than guessing", () => {
		expect(classify("curl/8.4.0")).toEqual({ kind: "unknown", name: "" });
		expect(classify(null)).toEqual({ kind: "unknown", name: "" });
		expect(classify("")).toEqual({ kind: "unknown", name: "" });
	});
});
