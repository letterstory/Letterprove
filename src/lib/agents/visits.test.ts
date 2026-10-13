import { describe, expect, it } from "vitest";
import { classifyVisit, MAX_PATH_LENGTH, normalizePath } from "./visits";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

describe("classifyVisit", () => {
	it("names AI agents and search crawlers from the user-agent", () => {
		expect(classifyVisit({ userAgent: "Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0" })).toEqual({ agent: "chatgpt", kind: "ai_agent" });
		expect(classifyVisit({ userAgent: "Claude-User/1.0 (+https://claude.com)" })).toEqual({ agent: "claude", kind: "ai_agent" });
		expect(classifyVisit({ userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" })).toEqual({ agent: "google", kind: "search_crawler" });
	});

	it("drops ordinary browsers and unrecognisable clients", () => {
		expect(classifyVisit({ userAgent: CHROME })).toBeNull();
		expect(classifyVisit({ userAgent: "curl/8.0" })).toBeNull();
		expect(classifyVisit({ userAgent: null })).toBeNull();
	});

	// ChatGPT's agent browses under a normal Chrome user-agent and marks its
	// requests with Signature-Agent instead.
	it("recognises ChatGPT's agent by its Signature-Agent header", () => {
		expect(classifyVisit({ userAgent: CHROME, signatureAgent: '"https://chatgpt.com"' })).toEqual({ agent: "chatgpt", kind: "ai_agent" });
	});

	it("counts a webdriver browser as an automated browser, not as a named agent", () => {
		expect(classifyVisit({ userAgent: CHROME, webdriver: true })).toEqual({ agent: "automated_browser", kind: "automated_browser" });
		expect(classifyVisit({ userAgent: CHROME, webdriver: false })).toBeNull();
	});
});

describe("normalizePath", () => {
	it("strips query strings and fragments, which carry search terms and tokens", () => {
		expect(normalizePath("/pricing?utm_source=chatgpt.com#plans")).toBe("/pricing");
	});

	it("accepts a full URL and keeps only its path", () => {
		expect(normalizePath("https://acme.example/docs/start?x=1")).toBe("/docs/start");
	});

	it("collapses id-like segments so one row isn't one visitor", () => {
		expect(normalizePath("/orders/12345")).toBe("/orders/:id");
		expect(normalizePath("/u/3f1c2b9e-1d2a-4c3b-8e4f-0a1b2c3d4e5f/settings")).toBe("/u/:id/settings");
		expect(normalizePath("/blog/how-we-ship")).toBe("/blog/how-we-ship");
	});

	it("adds the leading slash, caps the length, and refuses non-strings", () => {
		expect(normalizePath("docs")).toBe("/docs");
		expect(normalizePath(`/${"page-".repeat(100)}`)!.length).toBe(MAX_PATH_LENGTH);
		expect(normalizePath(42)).toBeNull();
		expect(normalizePath("  ")).toBeNull();
	});
});
