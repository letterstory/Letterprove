import type { Tier } from "./types";

/**
 * The three states of a vendor's claim to its domain (since 2026-10-14, when
 * DNS became optional for publishing):
 *
 *   none — nothing proven. The counts are the vendor's claim. Tier 0.
 *   site — Letterprove found attest.js with the vendor's key on a page of the
 *          domain (lib/vendors/site-proof.ts). Proves control of a page, not
 *          the domain's DNS. Tier 1 at most.
 *   dns  — the vendor published Letterprove's TXT record. Tiers 1 and 3.
 *
 * Pure, so the signer, the pages and the tools all grade the same way.
 */
export type DomainProof = "none" | "site" | "dns";

/** The strongest proof a vendor carries. DNS wins over site. */
export function domainProofOf(v: { domainVerified?: boolean; siteVerifiedAt?: string | null }): DomainProof {
	if (v.domainVerified) return "dns";
	if (v.siteVerifiedAt) return "site";
	return "none";
}

/**
 * The tier the aggregate earns. Site proof stops at tier 1, never above DNS:
 * tier 1 says browser sign-ins were observed on pages the vendor controls,
 * which a page carrying the vendor's key establishes.
 *
 * Tier 3 adds a third party vouching for WHO the vendor is: Stripe has
 * verified the business behind the vendor's own Stripe account (it can accept
 * payments), and that account's website is on the vendor's domain (or staff
 * approved the account). It still needs DNS: tying a Stripe account's website
 * to "this vendor" is only as strong as the vendor's proof of the domain, and a
 * page carrying our key proves a page, not the domain. Since 2026-10-14 no
 * payments are read; before that, tier 3 meant an observed company had paid.
 *
 *   3 — dns, companies observed, Stripe-verified business at that domain;
 *   1 — dns or site, companies observed;
 *   0 — nothing observed, or no proof of the domain at all.
 */
export function tierForProof(observed: boolean, proof: DomainProof, stripeBusinessConfirmed = false): Tier {
	if (!observed || proof === "none") return 0;
	if (proof === "site") return 1;
	return stripeBusinessConfirmed ? 3 : 1;
}

/**
 * Labels used on every public surface. A domain nothing proves carries no label at all (Casey, 2026-11-13: say
 * "Domain verified" where the TXT record is, and nothing where it isn't); its tier (0) and `domain_proof: none`
 * in the signed document still tell an agent.
 */
export const DOMAIN_PROOF_LABEL = {
	none: null,
	site: "Site verified",
	dns: "Domain verified",
} as const satisfies Record<DomainProof, string | null>;

/** The one plain line that explains a label. Null for DNS (nothing to caveat) and for none (no label to explain). */
export function domainProofLine(proof: DomainProof, domain?: string | null): string | null {
	const d = domain ?? "its domain";
	if (proof === "site") {
		return `Site verified: Letterprove found this vendor's script and key on a page at ${d}. That proves control of a page, not of the domain's DNS, so it is weaker than DNS verification.`;
	}
	return null;
}

/**
 * The proof a signed document states. `domain_proof` since 2026-10-14; before
 * that `domain_verified_since` (DNS or nothing). Documents older than both (no
 * `domain` at all) could only be published with DNS proof.
 */
export function docDomainProof(
	doc: { domain?: string; domain_proof?: DomainProof; domain_verified_since?: string | null } | null | undefined,
): DomainProof {
	if (!doc) return "none";
	if (doc.domain_proof === "none" || doc.domain_proof === "site" || doc.domain_proof === "dns") return doc.domain_proof;
	if (doc.domain === undefined) return "dns";
	return doc.domain_verified_since ? "dns" : "none";
}
