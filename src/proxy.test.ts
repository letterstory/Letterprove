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

	it("leaves our own root alone", async () => {
		const { proxy: p } = await freshProxy({});
		expect(await p(new NextRequest("https://app.letterprove.com/", { headers: { host: "app.letterprove.com" } }))).toBeUndefined();
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
