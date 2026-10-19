import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

describe("proxy — /proofs content negotiation", () => {
	it("rewrites a .json suffix to the API route", async () => {
		const { proxy: p } = await freshProxy();
		const res = await p(new NextRequest("https://app.letterprove.com/proofs/vantage.json"));
		expect(new URL(res!.headers.get("x-middleware-rewrite")!).pathname).toBe(
			"/api/proofs/vantage",
		);
	});

	it("rewrites an explicit JSON accept (no HTML alternative) to the API route", async () => {
		const { proxy: p } = await freshProxy();
		const res = await p(
			new NextRequest("https://app.letterprove.com/proofs/vantage", {
				headers: { accept: "application/json" },
			}),
		);
		expect(new URL(res!.headers.get("x-middleware-rewrite")!).pathname).toBe(
			"/api/proofs/vantage",
		);
	});

	it("leaves a browser request (text/html accept) alone", async () => {
		const { proxy: p } = await freshProxy();
		const res = await p(
			new NextRequest("https://app.letterprove.com/proofs/vantage", {
				headers: { accept: "text/html,application/xhtml+xml,*/*" },
			}),
		);
		expect(res).toBeUndefined();
	});

	it("never touches the public collection/proof API", async () => {
		const { proxy: p } = await freshProxy();
		const res = await p(new NextRequest("https://app.letterprove.com/api/v1/observe"));
		expect(res).toBeUndefined();
	});
});

describe("proxy — a vendor's own proof domain", () => {
	it("serves the vendor's proof page at the root of its custom domain", async () => {
		const { proxy: p } = await freshProxy({ "proof.acme.com": "acme" });
		const res = await p(new NextRequest("https://proof.acme.com/", { headers: { host: "proof.acme.com" } }));
		expect(new URL(res!.headers.get("x-middleware-rewrite")!).pathname).toBe("/proofs/acme");
	});

	it("serves the JSON to an agent asking for JSON", async () => {
		const { proxy: p } = await freshProxy({ "proof.acme.com": "acme" });
		const res = await p(new NextRequest("https://proof.acme.com/", { headers: { host: "proof.acme.com", accept: "application/json" } }));
		expect(new URL(res!.headers.get("x-middleware-rewrite")!).pathname).toBe("/api/proofs/acme");
	});

	it("answers 404 for an unknown or unpublished hostname, never our home page", async () => {
		const { proxy: p } = await freshProxy({});
		const res = await p(new NextRequest("https://proof.nobody.com/", { headers: { host: "proof.nobody.com" } }));
		expect(res!.status).toBe(404);
	});

	it("serves only that vendor's documents on its domain, never another vendor's", async () => {
		const { proxy: p } = await freshProxy({ "proof.acme.com": "acme" });
		const get = (path: string) => p(new NextRequest(`https://proof.acme.com${path}`, { headers: { host: "proof.acme.com" } }));
		expect(await get("/attest/acme.json")).toBeUndefined();
		expect((await get("/attest/rival.json"))!.status).toBe(404);
		expect((await get("/proofs/rival"))!.status).toBe(404);
		expect((await get("/admin"))!.status).toBe(404);
		const docs = await get("/docs");
		expect(docs!.status).toBe(308);
		expect(docs!.headers.get("location")).toBe("https://app.letterprove.com/docs");
	});

	it("sends keys, discovery and verify pages home, so a vendor's DNS can never serve its own keys", async () => {
		const { proxy: p } = await freshProxy({ "proof.acme.com": "acme" });
		const get = (path: string) => p(new NextRequest(`https://proof.acme.com${path}`, { headers: { host: "proof.acme.com" } }));
		for (const path of [
			"/keys",
			"/verify",
			"/verify/acme/20261012T160507661Z?format=json",
			"/.well-known/letterprove-jwks.json",
			"/.well-known/letterprove.json",
			"/api/well-known/letterprove",
		]) {
			const res = await get(path);
			expect(res!.status, path).toBe(308);
			expect(res!.headers.get("location"), path).toBe(`https://app.letterprove.com${path}`);
		}
	});

	it("leaves our own root alone", async () => {
		const { proxy: p } = await freshProxy({});
		expect(await p(new NextRequest("https://app.letterprove.com/", { headers: { host: "app.letterprove.com" } }))).toBeUndefined();
	});
});

describe("proxy — LetterVisit forwarding", () => {
	const event = () => {
		const waited: Promise<unknown>[] = [];
		return { waited, ev: { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never };
	};
	const bot = { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)" };

	it("forwards a crawler on Letterprove's own pages", async () => {
		vi.stubEnv("NEXT_PUBLIC_LETTERVISIT_KEY", "lv_pub_test");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
		const { proxy: p } = await freshProxy();
		const { waited, ev } = event();
		await p(new NextRequest("https://www.letterprove.com/docs", { headers: { ...bot, host: "www.letterprove.com" } }), ev);
		expect(waited).toHaveLength(1);
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("never forwards from a vendor's proof domain, a browser, or the API", async () => {
		const { proxy: p } = await freshProxy({ "proof.acme.com": "acme" });
		const { waited, ev } = event();
		await p(new NextRequest("https://proof.acme.com/", { headers: { ...bot, host: "proof.acme.com" } }), ev);
		await p(new NextRequest("https://www.letterprove.com/", { headers: { "user-agent": "Mozilla/5.0 Chrome/130.0", host: "www.letterprove.com" } }), ev);
		await p(new NextRequest("https://www.letterprove.com/api/v1/observe", { headers: { ...bot, host: "www.letterprove.com" } }), ev);
		expect(waited).toHaveLength(0);
	});
});

async function freshProxy(hosts: Record<string, string> = {}) {
	vi.doMock("@/lib/vendors/custom-domain", async (orig) => ({
		...(await orig<typeof import("@/lib/vendors/custom-domain")>()),
		slugForCustomDomain: async (h: string) => hosts[h] ?? null,
	}));
	vi.resetModules();
	return import("./proxy");
}
