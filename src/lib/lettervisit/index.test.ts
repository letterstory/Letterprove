import { afterEach, describe, expect, it, vi } from "vitest";

describe("lettervisit", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("is Letterprove's own site only, never a vendor's proof domain or the app", async () => {
		const { isLettervisitHost } = await import(".");
		expect(isLettervisitHost("letterprove.com")).toBe(true);
		expect(isLettervisitHost("www.letterprove.com:443")).toBe(true);
		expect(isLettervisitHost("app.letterprove.com")).toBe(false);
		expect(isLettervisitHost("proof.acme.com")).toBe(false);
	});

	it("reports pages, not the API, discovery documents, signed JSON or files", async () => {
		const { isLettervisitPage } = await import(".");
		for (const p of ["/", "/docs", "/proofs/vantage", "/pricing"]) expect(isLettervisitPage(p)).toBe(true);
		for (const p of ["/api/proofs/x", "/v1/observe", "/.well-known/jwks.json", "/attest/x", "/proofs/vantage.json", "/logo.svg"])
			expect(isLettervisitPage(p)).toBe(false);
	});

	it("posts letterprove.com's key with the request it saw", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const { forwardAgentVisit, LETTERVISIT_KEY } = await import(".");
		expect(LETTERVISIT_KEY).toMatch(/^lv_pub_[a-z0-9]{24}$/);
		await forwardAgentVisit({ userAgent: "GPTBot/1.2", ip: null, path: "/", host: "www.letterprove.com", signatureAgent: null });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://lettervisit.com/api/v1/agent-visit");
		expect(JSON.parse(init.body)).toMatchObject({ k: LETTERVISIT_KEY, ua: "GPTBot/1.2", host: "www.letterprove.com", path: "/" });
	});
});
