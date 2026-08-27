/**
 * How long a decline blocks a re-ask, and the arithmetic for deciding whether
 * it still does.
 *
 * Its own module, with no imports at all, because both sides need it: the
 * server enforces it in `generateConsentLink`, and the vendor dashboard has to
 * answer the same question to decide whether to render a button. Living in
 * customers.ts would drag `node:crypto` and the Supabase client into the
 * browser bundle; re-deriving it in the component would drift, and the way it
 * would drift is the UI offering a button the API then refuses — which reads
 * as a broken dashboard rather than as the deliberate rule it is.
 */

/**
 * A decline used to be free to ignore: nothing was recorded, so a vendor could
 * re-send instantly and repeatedly, and the customer — who has no account, no
 * dashboard, and no other way to object — had no way to stop it.
 *
 * 30 days is the middle position between that and treating a "no" as
 * permanent. A decline is often about timing or the wrong recipient, so asking
 * again has to stay possible; it just must not be instant or invisible. The
 * number is a judgement call, not a derived one: long enough that a re-ask is
 * a considered act rather than a reflex, short enough that a genuine "not this
 * quarter" doesn't become never.
 */
export const CONSENT_REASK_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export type ConsentCooldown = { declinedAt: string; canAskAgainAt: string };

/**
 * Whether a decline still blocks a re-ask, and until when.
 *
 * Returns null once the window has passed — the decline stays recorded and
 * stays visible, it just no longer blocks. "Declined" is permanent history;
 * "can't ask yet" is not.
 *
 * `now` is injectable so the tests can sit on both sides of the boundary
 * without sleeping or stubbing the clock globally.
 */
export function consentCooldown(declinedAt: string | null | undefined, now: Date = new Date()): ConsentCooldown | null {
	if (!declinedAt) return null;

	const declined = new Date(declinedAt);
	// A malformed timestamp must not block a legitimate request forever. It also
	// must not silently read as "never declined" — but the column is written
	// only by recordConsentDecision with an ISO string, so the reachable cause
	// is corruption, and failing open on a re-ask is the milder of the two.
	if (Number.isNaN(declined.getTime())) return null;

	const until = new Date(declined.getTime() + CONSENT_REASK_COOLDOWN_MS);
	if (until <= now) return null;

	return { declinedAt: declined.toISOString(), canAskAgainAt: until.toISOString() };
}
