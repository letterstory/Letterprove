import type { Tier } from "./types";

/**
 * The provenance ladder, published so an agent doesn't have to infer it.
 *
 * Until this existed, a document said `"tier": 2` and nothing anywhere in the
 * machine-readable surface said what 2 meant. The ladder lived in
 * `scripts/verify.mjs` — whose own docblock describes its copy as "restated
 * here from the published description", a description that was never actually
 * published — and in the README, as prose. So an agent could verify a
 * signature perfectly and still have no basis for weighting the claim.
 *
 * That is the more dangerous direction. An agent that can't read the tier
 * doesn't distrust us; it OVER-trusts us. It verifies a valid signature over a
 * tier-0 body — which asserts only that the vendor said so — and reports
 * "attested", which is exactly the reading the tiers exist to prevent. Nobody
 * lied; we just never shipped the key to what we published.
 *
 * `forgeable_by` is the field that earns its place. "What evidence is this"
 * is interesting; "who could fake it" is what an agent deciding whether to
 * recommend someone actually needs, and it is the honest way to say that our
 * lower tiers are weak.
 *
 * NOT signed, and deliberately so. This is a description of the scheme, not a
 * claim about a vendor. Putting it in the signed body would change what every
 * future attestation commits to, and bloat each document with bytes identical
 * across all of them — see the note in tiers.test.ts about keeping the
 * verifier's copy independent.
 */

export interface TierDescription {
	/** Short name. Must match scripts/verify.mjs's vocabulary — asserted in tiers.test.ts. */
	name: string;
	/** What produced the claim. */
	means: string;
	/** Who could produce this tier dishonestly, stated plainly. */
	forgeable_by: string;
}

export const TIER_LADDER: Record<Tier, TierDescription> = {
	0: {
		name: "vendor-asserted",
		means: "The vendor stated this. Nothing corroborates it — either no usage was observed, or the vendor has not proven control of the domain events are pinned to.",
		forgeable_by: "The vendor alone, trivially. Treat as a claim, not as evidence.",
	},
	1: {
		name: "script-observed",
		means: "Letterprove's script reported usage attributable to this company's email domain.",
		forgeable_by:
			"The vendor, with effort. The collector pins events to a verified origin, which a browser cannot forge — but a non-browser client can send whatever origin it likes.",
	},
	2: {
		name: "infrastructure-bound",
		means: "Observed usage carrying a Letterprove-side receipt timestamp and an origin pinned to a domain the vendor proved control of by DNS.",
		forgeable_by:
			"A determined vendor running a distributed spoofing rig. Volume and burst anomalies are scored against it; a slow, well-distributed rig is an accepted open gap.",
	},
	3: {
		name: "third-party confirmed",
		means: "An invoice that actually settled for this company, read directly from the vendor's own live-mode Stripe account, alongside observed usage. A subscription on its own does not qualify: it says what the vendor meant to bill, and a free one reaches `active` for nothing.",
		forgeable_by:
			"A vendor willing to pay themselves. Every condition is checked against a third party's ledger rather than the vendor's word, and money has to genuinely move through a processor in a Stripe-verified live account — but a vendor prepared to spend real money on a lie can still reach it. Read this as corroboration, not as immunity.",
	},
	4: {
		name: "customer counter-signed",
		means: "The customer reviewed this exact usage summary and approved it, at a link delivered to an address on their own domain. The vendor never held that link.",
		forgeable_by:
			"Nobody, without control of a mailbox at the customer's own domain. A vendor who registers a domain and invents a company on it controls both ends — fraud scoring, not this tier, is the backstop for that.",
	},
};

/**
 * The published form. A flat list keyed by tier, plus the one sentence that
 * stops the whole thing being misread: a valid signature is not the claim, the
 * tier is.
 */
export function tierLadderDocument() {
	return {
		note: "Every attestation carries a `tier`. A valid signature proves only that this document is ours and unaltered — it says nothing about how good the underlying evidence is. The tier says that, and it is the claim. A signed tier-0 document asserts only that the vendor said so.",
		levels: (Object.keys(TIER_LADDER) as unknown as Tier[])
			.map(Number)
			.sort((a, b) => a - b)
			.map((tier) => ({ tier, ...TIER_LADDER[tier as Tier] })),
	};
}
