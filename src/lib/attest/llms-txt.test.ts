import { describe, expect, it } from "vitest";
import { llmsTxt } from "./llms-txt";
import { tierLadderDocument } from "./tiers";
import type { DiscoveryDocument } from "./discovery";

const doc = (over: Partial<DiscoveryDocument> = {}): DiscoveryDocument => ({
	name: "Letterprove",
	description: "x",
	signing: { alg: "EdDSA", crv: "Ed25519", jwks_uri: "https://app.letterprove.com/.well-known/letterprove-jwks.json", canonicalization: "m", mode: "countersigned" },
	verifier: "https://github.com/letterstory/Letterprove/blob/abc/scripts/verify.mjs",
	freshness: { cadence_seconds: 3600, note: "A snapshot does not expire." },
	verify_links: { pattern: "p", note: "n" },
	issuer: {
		operator: "Letter Company",
		vendor_controls: ["whether its proofs are public"],
		vendor_cannot: ["hold or use the signing key"],
		affiliated_vendors: [{ vendor: "letterstory", shared_owner: "Letter Company" }],
		note: "n",
	},
	tiers: tierLadderDocument(),
	proofs: [
		{
			vendor: "letterstory",
			url: "https://app.letterprove.com/proofs/letterstory",
			aggregate: "https://app.letterprove.com/attest/letterstory.json",
			aggregate_chain: "https://app.letterprove.com/attest/letterstory/chain", domain_proof: "dns" as const,
		},
	],
	...over,
});

describe("llmsTxt", () => {
	it("lists exactly the published proofs from the discovery document", () => {
		const text = llmsTxt(doc(), "https://app.letterprove.com");
		expect(text).toContain("[letterstory](https://app.letterprove.com/proofs/letterstory)");
		expect(text).toContain("https://app.letterprove.com/attest/letterstory/chain");
	});

	it("says so when nothing is published, rather than listing examples", () => {
		expect(llmsTxt(doc({ proofs: [] }), "https://app.letterprove.com")).toContain("None published yet.");
	});

	it("carries every tier with who could forge it, and names vendor-stated fields", () => {
		const text = llmsTxt(doc(), "https://app.letterprove.com");
		for (const level of tierLadderDocument().levels) expect(text).toContain(`Tier ${level.tier}, ${level.name}`);
		expect(text).toContain("Forgeable by:");
		expect(text).toContain("vendor_stated");
	});

	it("points verification at Letterprove's own origin even when served from another host", () => {
		const text = llmsTxt(doc(), "https://preview.example.vercel.app");
		expect(text).toContain("https://app.letterprove.com/keys");
		expect(text).toContain("https://app.letterprove.com/verify");
	});

	it("discloses affiliated vendors and passes a development warning through", () => {
		const text = llmsTxt(doc({ warning: "DEVELOPMENT DEPLOYMENT" }), "https://x");
		expect(text).toContain("WARNING: DEVELOPMENT DEPLOYMENT");
		expect(text).toContain("disclosed in every attestation: letterstory");
	});
});
