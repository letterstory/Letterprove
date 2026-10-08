/**
 * The link every signed attestation carries to its own authoritative copy.
 *
 * WHY A LINK AND NOT AN ENDPOINT YOU POST TO. Answer engines cannot POST, and
 * the fetch tools Claude and Gemini use will only open a URL that already
 * appears in the conversation. A "send us a document and we'll check it"
 * endpoint would work for a developer and for no engine. So the document
 * carries the URL itself (`verify`, signed with everything else): wherever an
 * engine meets a proof — pasted into a prompt, quoted on a vendor's site — the
 * link to check it is already in front of it, and fetching it answers in plain
 * language with the figures Letterprove actually signed. No cryptography on
 * the engine's side.
 *
 * In the 2026-10-08 AEO stress test Gemini fetched our keys, ran code, and
 * still called a tampered document's signature valid in 7 of 16 answers.
 * Against a link it only has to compare numbers: a tampered copy points at the
 * real figures, and a forged one points nowhere (or at a real snapshot whose
 * figures differ from the forgery's).
 *
 * The URL is built from the vendor, the customer (for a per-customer
 * attestation) and the snapshot's `published_at` — all known before signing,
 * so the link can sit inside what the signature covers without being circular.
 * The origin is fixed: it is signed into the body, and a document must never
 * point at whichever host happened to build it. A development deployment's
 * documents therefore point at production and 404 there, which is the honest
 * answer for a demonstration key.
 */

export const VERIFY_ORIGIN = "https://app.letterprove.com";

/** `2026-10-08T17:01:21.613Z` → `20261008T170121613Z`: URL-safe, one per snapshot. */
export function snapshotStamp(publishedAt: string): string {
	return new Date(publishedAt).toISOString().replace(/[-:.]/g, "");
}

export function verifyLink(vendor: string, customer: string | null, publishedAt: string): string {
	const path = customer ? `${vendor}/${customer}` : vendor;
	return `${VERIFY_ORIGIN}/verify/${path}/${snapshotStamp(publishedAt)}`;
}

/** Path segments after /verify/{vendor}/ → which document is meant, or null when the shape is wrong. */
export function parseVerifyPath(rest: string[]): { customer: string | null; stamp: string } | null {
	const stampShape = /^\d{8}T\d{9}Z$/;
	if (rest.length === 1 && stampShape.test(rest[0])) return { customer: null, stamp: rest[0] };
	if (rest.length === 2 && stampShape.test(rest[1])) return { customer: rest[0], stamp: rest[1] };
	return null;
}
