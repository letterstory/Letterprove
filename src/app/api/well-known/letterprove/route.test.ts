import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/attest/proofs", () => ({ vendorSlugs: vi.fn() }));
vi.mock("@/lib/attest/keys", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/attest/keys")>()),
	isDemonstration: vi.fn(),
	signingMode: vi.fn(),
}));

const REQ = new Request("https://app.letterprove.com/.well-known/letterprove.json");

async function discovery(opts: { slugs?: string[]; demo?: boolean } = {}) {
	const { vendorSlugs } = await import("@/lib/attest/proofs");
	const { isDemonstration, signingMode } = await import("@/lib/attest/keys");
	vi.mocked(vendorSlugs).mockResolvedValue(opts.slugs ?? ["lettertrace"]);
	vi.mocked(isDemonstration).mockReturnValue(opts.demo ?? false);
	vi.mocked(signingMode).mockReturnValue(opts.demo ? "development" : "countersigned");
	return (await GET(REQ)).json();
}

beforeEach(() => vi.clearAllMocks());

describe("GET /.well-known/letterprove.json", () => {
	// This document is an agent's entry point. The aggregate is the only claim
	// most vendors will ever publish — naming a customer needs that customer's
	// consent — so a discovery document that advertised only the report would
	// send agents past the one thing actually signed for them.
	it("advertises the aggregate and its chain, not just the report", async () => {
		const d = await discovery();
		expect(d.proofs).toEqual([
			{
				vendor: "lettertrace",
				url: "https://app.letterprove.com/proofs/lettertrace",
				aggregate: "https://app.letterprove.com/attest/lettertrace.json",
				aggregate_chain: "https://app.letterprove.com/attest/lettertrace/chain",
			},
		]);
	});

	it("lists every vendor", async () => {
		const d = await discovery({ slugs: ["vantage", "lettertrace"] });
		expect(d.proofs.map((p: { vendor: string }) => p.vendor)).toEqual(["vantage", "lettertrace"]);
	});

	it("states the signing mode so provenance is read, not inferred", async () => {
		expect((await discovery()).signing.mode).toBe("countersigned");
	});

	// The inverse of the bug that shipped on 2026-08-13, when production served
	// real countersigned proofs under a "not evidence" warning.
	it("warns only when signing really is a demonstration", async () => {
		expect((await discovery({ demo: false })).warning).toBeUndefined();
		expect((await discovery({ demo: true })).warning).toMatch(/not evidence/i);
	});
});
