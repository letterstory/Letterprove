/**
 * The footer badge a vendor puts on their own site: "Attested and proven by
 * Letterprove", linking to their public proof page.
 *
 * Plain HTML with the mark drawn inline. A customer's site may run a strict
 * CSP, may have no JavaScript budget, and is read by crawlers and engines that
 * run no script at all — so the badge loads nothing from us and works with
 * scripts off. It inherits the footer's text colour and size so it sits in any
 * design.
 *
 * The link is also how an engine finds the proof. Engine fetch tools open only
 * URLs already in front of them (see verify-link.ts); a vendor's own page is
 * where an evaluation starts, so a link there is the path from "Acme says" to
 * "Letterprove signed".
 *
 * ONLY ONCE PUBLISHED. An unpublished vendor's proof page answers 404 by design
 * (README, "A vendor is private until someone publishes them"), so a badge
 * before publishing is a claim of proof with nothing behind it — the one thing
 * the trust model forbids. `live` says which; callers show the badge only when
 * it is true.
 */

/** The public proof page a badge points at, on the origin serving proofs. */
export function proofPageUrl(origin: string, slug: string): string {
	return `${origin}/proofs/${encodeURIComponent(slug)}`;
}

export const BADGE_TEXT = "Attested and proven by Letterprove";

/** The Letterprove mark: the four-point star on its green square, at 14px. */
const MARK =
	'<svg width="14" height="14" viewBox="0 0 70 70" aria-hidden="true" style="flex:none">' +
	'<rect width="70" height="70" rx="8" fill="#00E0A8"/>' +
	'<path d="M35 9Q38 32 61 35Q38 38 35 61Q32 38 9 35Q32 32 35 9Z" fill="#fff"/></svg>';

export function badgeHtml(origin: string, slug: string): string {
	return (
		`<a href="${proofPageUrl(origin, slug)}" target="_blank" rel="noopener" ` +
		`title="Usage on this site is observed and signed by Letterprove. Click to check it." ` +
		`style="display:inline-flex;align-items:center;gap:6px;color:inherit;text-decoration:none;font-size:inherit;line-height:1.2">` +
		`${MARK}<span>${BADGE_TEXT}</span></a>`
	);
}
