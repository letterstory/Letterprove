/**
 * The order an attestation's fields are SERVED in — not the order they are signed in.
 *
 * Signing is over canonical bytes (canonical.ts: keys sorted), so the order a
 * route writes the keys in changes nothing a verifier computes. But an engine
 * reading the document does read it top to bottom, and the order it had was an
 * accident: snapshots live in a `jsonb` column, and Postgres stores jsonb keys
 * shortest-first. On 2026-10-12 lettertrace's aggregate served `verify` as the
 * 8th of 18 fields, after `logins` and `method`, and `issuer_affiliation` dead
 * last because it is the longest key.
 *
 * That placement is measured, not cosmetic. Run 6 (experiments/aeo/README.md):
 * when Gemini opened the verify link it was right 8/8 times, but it opened it
 * in only 8 of 42 proof cells. Run 7: Claude, which reads further, opened it in
 * 15–16/16 and punished every tampered and forged document. The check works;
 * the lever is getting a reader to the link before it stops reading.
 *
 * So: the link to check this document comes first, then who issued it, then
 * what it is about. The signature and its key come last, since nothing reads
 * them by eye. Everything else keeps its stored order.
 */

const LEAD = [
	"verify",
	"issuer_affiliation",
	"vendor",
	"customer",
	"customer_name",
	"customer_domain",
	"kind",
	"domain",
	"domain_verified_since",
	"stripe_account_bound",
	"stripe_binding",
	"verified",
	"tier",
	"companies_observed",
	"paying_companies",
	"vendor_stated",
] as const;

const TAIL = ["prev_hash", "key_id", "signature"] as const;

const PINNED = new Set<string>([...LEAD, ...TAIL]);

/** The same document with its keys in reading order. Values, and therefore the signature, are untouched. */
export function readingOrder<T extends object>(doc: T): T {
	const src = doc as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of LEAD) if (k in src) out[k] = src[k];
	for (const k of Object.keys(src)) if (!PINNED.has(k)) out[k] = src[k];
	for (const k of TAIL) if (k in src) out[k] = src[k];
	return out as T;
}
