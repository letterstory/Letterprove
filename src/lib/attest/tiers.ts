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
		means: "Nothing is verified. Either no sign-ins were observed, or the vendor's domain is not verified by DNS. The daily DNS check also drops a vendor to tier 0 when its record is removed.",
		forgeable_by: "The vendor alone. Treat tier 0 as a claim.",
	},
	1: {
		name: "script-observed",
		means: "Letterprove's script observed sign-ins from company email domains on the vendor's DNS-verified domain. `companies_observed` is the number of companies. Letterprove timestamps each event on arrival. The vendor does not report any figure.",
		forgeable_by:
			"The vendor, with effort. Browsers cannot fake the origin of an event. A script outside a browser can, so a vendor could script sign-ins. Letterprove scores volume and burst anomalies against this.",
	},
	2: {
		name: "infrastructure-bound",
		means: "Not issued. Reserved for observed usage tied to network facts the vendor cannot choose, such as the spread of networks (ASNs) that sign-ins come from. This check is not built, so no new document carries tier 2. Documents signed before 2026-10-13 may carry tier 2 for tier-1 evidence. Read those as tier 1.",
		forgeable_by:
			"When issued: a vendor running sign-ins from many networks on purpose. For older documents that carry it: the same as tier 1.",
	},
	3: {
		name: "third-party confirmed",
		means: "Tier 1, plus at least one observed company paid a settled invoice in the vendor's live Stripe account. The account must publish the vendor's verified domain, or be approved by Letterprove staff (`stripe_binding`). Letterprove reads the invoices from Stripe directly. A subscription alone does not count, because a free subscription can be active without payment. Tier 3 does not mean every company pays. The number of paying companies is private to the vendor.",
		forgeable_by:
			"A vendor willing to pay itself through its own Stripe account. Every check runs against Stripe's records, and real money must settle in a live, Stripe-verified account. Tier 3 is strong corroboration. It does not stop a vendor willing to spend money to fake it.",
	},
	4: {
		name: "customer counter-signed (retired)",
		means: "No longer issued. Retired on 2026-10-12. Older documents may carry it. It meant a customer approved a usage summary from a link sent to their own domain. Tier 3 is the highest tier a new document can carry.",
		forgeable_by:
			"For older documents: anyone with a mailbox at the customer's domain, including a vendor who registered that domain. Read it as tier 3 at most.",
	},
};

/**
 * The published form. A flat list keyed by tier, plus the one sentence that
 * stops the whole thing being misread: a valid signature is not the claim, the
 * tier is.
 */
/** Tiers that no new document carries. Kept readable for old snapshots, never listed as a level. */
const RETIRED: readonly Tier[] = [4];

export function tierLadderDocument() {
	const byTier = (tiers: Tier[]) => tiers.sort((a, b) => a - b).map((tier) => ({ tier, ...TIER_LADDER[tier] }));
	return {
		note: "Every attestation carries a `tier`. A valid signature proves the document came from Letterprove and was not changed. The tier states how strong the evidence is. A signed tier-0 document only shows that the vendor exists. Since 2026-10-13 there is one attestation per vendor, in counts. Older per-customer documents carry a tier for one customer.",
		/** The ladder a new document is graded on. Tier 3 is the highest. */
		levels: byTier((Object.keys(TIER_LADDER).map(Number) as Tier[]).filter((t) => !RETIRED.includes(t))),
		/** No longer issued. Old snapshots may carry these and still verify. */
		retired: byTier([...RETIRED]),
	};
}
