/**
 * Who issues Letterprove attestations, what a vendor can and cannot do to
 * them, and — when the vendor and the issuer share an owner — the disclosure.
 *
 * One module so the discovery document, the signed bodies and the proof page
 * say the same thing in the same words.
 *
 * WHY DISCLOSE RATHER THAN DOWNPLAY. In the 2026-10-08 AEO stress test Claude
 * worked out from the names alone that Letterprove and Lettertrace are related
 * — "the vendor's sister project is vouching for the vendor" — and discounted
 * the proof for it. An objection an engine discovers costs more than a fact we
 * state, so a vendor whose `issuer_affiliation` is set carries the disclosure
 * inside every document it signs, where an engine reading only the document
 * still sees it. The independence argument rests on what the vendor cannot
 * touch, not on who owns whom.
 */

export const ISSUER_OPERATOR = "Letter Company";

/** What a vendor decides. Kept to what the code actually lets a vendor do. */
export const VENDOR_CONTROLS = [
	"whether its proofs are public",
	"which of its Stripe products count as this product (the attestation states how many, in `payment_scope`, never which)",
	"which extra hosts on its own domain the collector accepts events from",
] as const;

/** What a vendor cannot do, and why each holds. */
export const VENDOR_CANNOT = [
	"edit any figure or tier. Letterprove's collector observes sign-ins, Letterprove reads settled invoices from Stripe, and the tier follows from that evidence",
	"use the signing key. Letterprove holds it",
	"change a past figure unnoticed. Each hourly snapshot is hash-chained to the one before it",
	"name a customer it does not already show on its own logo wall. Everything else is counts, and customer domains stay inside Letterprove",
	"connect a Stripe account that is not its own. The account must publish the vendor's verified domain, or Letterprove staff must approve it (`stripe_binding: staff_override`)",
] as const;

/**
 * The sentence signed into an affiliated vendor's attestations, or null for an
 * independent one. Absent on documents signed before 2026-10-08.
 */
export function affiliationDisclosure(vendorName: string, affiliation: string | null): string | null {
	if (!affiliation) return null;
	return `Letterprove and ${vendorName} are both operated by ${affiliation}. The same collector, code and signing apply to it as to any other vendor, and every figure can be checked the same way.`;
}

/** The signed disclosure field, present only for a vendor that shares an owner with the issuer. */
export function withDisclosure(vendorName: string, affiliation: string | null): { issuer_affiliation?: string } {
	const disclosure = affiliationDisclosure(vendorName, affiliation);
	return disclosure ? { issuer_affiliation: disclosure } : {};
}
