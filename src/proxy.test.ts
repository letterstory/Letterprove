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

async function freshProxy() {
	vi.resetModules();
	return import("./proxy");
}
