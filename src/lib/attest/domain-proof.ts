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
 * which a page carrying the vendor's key establishes. Tier 3 needs the Stripe
 * account bound to the domain, and that binding is a DNS fact.
 *
 *   3 — dns, companies observed, at least one pays through the bound account;
 *   1 — dns or site, companies observed;
 *   0 — nothing observed, or no proof of the domain at all.
 */
export function tierForProof(observed: boolean, proof: DomainProof, payingCompanies = 0): Tier {
	if (!observed || proof === "none") return 0;
	if (proof === "site") return 1;
	return payingCompanies > 0 ? 3 : 1;
}

/** Labels, one per state, used on every public surface. */
export const DOMAIN_PROOF_LABEL: Record<DomainProof, string> = {
	none: "Domain not verified",
	site: "Site verified",
	dns: "Verified by DNS",
};

/** The one plain line that explains a label. Null for DNS: nothing to caveat. */
export function domainProofLine(proof: DomainProof, domain?: string | null): string | null {
	const d = domain ?? "its domain";
	if (proof === "none") {
		return `Domain not verified: this vendor has not proven that it controls ${d}, so treat these counts as the vendor's claim, not as evidence.`;
	}
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
