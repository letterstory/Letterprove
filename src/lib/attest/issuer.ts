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
	"which optional sections show (sessions, PostHog history, logos, Stripe business details, first observed date, extra hosts, growth, retention) — a hidden section is listed in `hidden_by_vendor`, and every absent section's reason is in `omitted`",
	"whether verified logo companies are named or only counted",
	"which extra hosts on its own domain the collector accepts events from",
] as const;

/** What a vendor cannot do, and why each holds. */
export const VENDOR_CANNOT = [
	"write, edit or delete any measured figure or tier — usage comes from Letterprove's own collector observing sign-ins on the vendor's domain (proven by DNS, or by site proof, which the document labels), business verification from the vendor's own Stripe account as Stripe states it, and the tier from that evidence alone",
	"hold or use the signing key — it is kept by the issuer, never by a vendor",
	"restate a past figure unnoticed — every hourly snapshot is hash-chained to the one before it",
	"name or publish any customer, except companies already on its own public logo wall that Letterprove observed signing in, and only if it opts in to logo verification",
	"vouch for a Stripe account that isn't its own — the account must publish the vendor's domain, unless Letterprove staff approve a related company's account (`stripe_binding: staff_override`)",
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
