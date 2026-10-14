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
		means: "Nothing corroborates a claim: no usage was observed, or the vendor has not proven control of its domain at all (`domain_proof: none`, labelled \"Domain not verified\"), or the daily re-check found its proof gone.",
		forgeable_by: "The vendor alone, trivially. Treat as a claim, not as evidence.",
	},
	1: {
		name: "script-observed",
		means: "Letterprove's script saw people from company email domains sign in, on a domain the vendor proved it controls: by DNS (`domain_proof: dns`), or by carrying Letterprove's script and its key on a page of that domain (`domain_proof: site`, labelled \"Site verified\"; it proves control of a page, not the domain's DNS, and is the weaker of the two). `companies_observed` says how many companies; Letterprove stamps when each event arrived and the vendor never reports a number.",
		forgeable_by:
			"The vendor, with effort. The collector pins events to the vendor's verified origin, which a browser cannot forge — but a non-browser client can send whatever origin it likes, so a vendor could script sign-ins. Volume and burst anomalies are scored against it.",
	},
	2: {
		name: "infrastructure-bound",
		means: "NOT YET ISSUED. Reserved for observed usage bound to network facts the vendor cannot choose (the spread of networks, by ASN, that sign-ins arrive from). That binding is not built, so no new document carries tier 2. Documents signed before 2026-10-13 may carry it for usage that met only the tier-1 bar: read those as tier 1.",
		forgeable_by:
			"When issued: a determined vendor running a distributed spoofing rig. For the historical documents that carry it: the same as tier 1.",
	},
	3: {
		name: "third-party confirmed",
		means: "Tier 1 on a DNS-proven domain, and a third party vouches for who the vendor is: Stripe has verified the business behind the vendor's own live-mode Stripe account (the account can accept payments, which Stripe allows only after checking the legal entity, the people behind it and a bank account), and that account's website is on the vendor's domain, or Letterprove staff approved the account (`stripe_binding: staff_override`). Shown in `stripe_business`. Site proof never reaches tier 3. Since 2026-10-14 no payment is read: tier 3 says nothing about revenue or which companies pay. On documents signed before then without `stripe_business`, it meant at least one observed company had paid a settled invoice in that account.",
		forgeable_by:
			"A vendor that controls a Stripe-verified business account publishing its domain, which in practice means a real, registered business at that domain. It does not stop a real business from scripting sign-ins (see tier 1). Read this as confirmation of identity, not of usage or revenue.",
	},
	4: {
		name: "customer counter-signed (retired)",
		means: "No longer issued; retired on 2026-10-12. Documents signed before then may carry it: it meant the customer approved that usage summary at a link emailed to an address on their own domain. Letterprove now attests from the vendor's DNS proof and the vendor's own Stripe ledger, so tier 3 is the highest tier a new document can carry.",
		forgeable_by:
			"For the historical documents that carry it: anyone controlling a mailbox at the customer's domain, including a vendor who registered that domain themselves. Read it no higher than tier 3.",
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
		note: "Every attestation carries a `tier`. A valid signature proves only that this document is ours and unaltered — it says nothing about how good the underlying evidence is. The tier says that, and it is the claim. A signed tier-0 document asserts nothing beyond the vendor existing. Since 2026-10-13 tiers describe the vendor's evidence as a whole (one attestation per vendor, counts only); older per-customer documents carry a tier for one customer.",
		/** The ladder a new document is graded on. Tier 3 is the highest. */
		levels: byTier((Object.keys(TIER_LADDER).map(Number) as Tier[]).filter((t) => !RETIRED.includes(t))),
		/** No longer issued. Old snapshots may carry these and still verify. */
		retired: byTier([...RETIRED]),
	};
}
