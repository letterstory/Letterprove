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

	it("is inert without a key, and posts the site key when set", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const input = { userAgent: "GPTBot/1.2", ip: null, path: "/", host: "www.letterprove.com", signatureAgent: null };
		vi.stubEnv("NEXT_PUBLIC_LETTERVISIT_KEY", "");
		await (await import(".")).forwardAgentVisit(input);
		expect(fetchMock).not.toHaveBeenCalled();
		vi.resetModules();
		vi.stubEnv("NEXT_PUBLIC_LETTERVISIT_KEY", "lv_pub_test");
		await (await import(".")).forwardAgentVisit(input);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ k: "lv_pub_test", ua: "GPTBot/1.2", host: "www.letterprove.com", path: "/" });
	});
});
