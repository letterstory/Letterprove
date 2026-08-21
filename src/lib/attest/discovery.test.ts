import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./proofs", () => ({ vendorSlugs: vi.fn() }));

import { vendorSlugs } from "./proofs";
import { discoveryDocument } from "./discovery";

/**
 * The discovery document is a published contract: an agent reads it to find
 * the keys, the canonicalisation, the verifier and what is published. Renaming
 * or dropping a field breaks every consumer silently, and we would not hear
 * about it — nobody files a bug on behalf of a crawler.
 *
 * It is now built in one place and rendered two ways (/.well-known JSON and
 * the /verify page), which is exactly when a shape test starts earning its
 * keep: a change made for the page's benefit must not alter the endpoint.
 */
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(vendorSlugs).mockResolvedValue(["acme", "globex"]);
});

describe("discoveryDocument", () => {
	it("publishes the fields an agent needs to verify without our docs", async () => {
		const doc = await discoveryDocument("https://app.letterprove.com");

		expect(Object.keys(doc).sort()).toEqual(
			expect.arrayContaining(["description", "name", "proofs", "signing", "verifier"]),
		);
		expect(Object.keys(doc.signing).sort()).toEqual([
			"alg",
			"canonicalization",
			"crv",
			"jwks_uri",
			"mode",
		]);
	});

	it("states the algorithm agents must implement", async () => {
		const doc = await discoveryDocument("https://app.letterprove.com");
		expect(doc.signing.alg).toBe("EdDSA");
		expect(doc.signing.crv).toBe("Ed25519");
	});

	it("builds every url from the origin it was asked for", async () => {
		// A hardcoded host is how cdn.letterprove.com — which never existed —
		// ended up in the install snippet.
		const doc = await discoveryDocument("https://preview.example.com");
		expect(doc.signing.jwks_uri).toBe(
			"https://preview.example.com/.well-known/letterprove-jwks.json",
		);
		for (const p of doc.proofs) {
			expect(p.url.startsWith("https://preview.example.com/")).toBe(true);
			expect(p.aggregate.startsWith("https://preview.example.com/")).toBe(true);
			expect(p.aggregate_chain.startsWith("https://preview.example.com/")).toBe(true);
		}
	});

	it("lists the aggregate and its chain for every vendor, not just the report", async () => {
		// The aggregate is the only claim most vendors ever publish, since
		// naming a customer needs that customer's consent. An agent that found
		// only `url` would miss the thing that is actually signed.
		const doc = await discoveryDocument("https://app.letterprove.com");
		expect(doc.proofs).toHaveLength(2);
		for (const p of doc.proofs) {
			expect(Object.keys(p).sort()).toEqual(["aggregate", "aggregate_chain", "url", "vendor"]);
		}
	});

	it("survives having nothing published", async () => {
		vi.mocked(vendorSlugs).mockResolvedValue([]);
		const doc = await discoveryDocument("https://app.letterprove.com");
		expect(doc.proofs).toEqual([]);
		expect(doc.signing.jwks_uri).toContain("/.well-known/");
	});
});
