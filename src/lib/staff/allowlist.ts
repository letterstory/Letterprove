/**
 * Who counts as staff.
 *
 * Letterprove holds no identity of its own — #124 retired its dashboard,
 * login, and OAuth server, and Letterstory is the sole identity authority
 * (see proxy.ts, oauth-auth.ts). The one door left in is the tool dispatcher,
 * reached with the shared LETTERSTORY_API_SECRET; every call already proves
 * "this is Letterstory's backend", not "this human is staff".
 *
 * STAFF_USER_IDS is how staff:read/staff:write get granted anyway, without
 * trusting Letterstory to assert it: Letterstory forwards the acting human's
 * (Letterstory) user id with the call, and oauth-auth.ts checks it against
 * this allowlist before adding the staff capabilities — see the longer
 * rationale on STAFF_CAPABILITIES there. So this list now holds LETTERSTORY
 * user ids, not ids from a Letterprove user pool that no longer exists.
 *
 * USER IDS, NOT EMAILS. An email allowlist would depend on this deployment
 * verifying address ownership, which it has no way to do for an identity it
 * doesn't hold.
 *
 * FAILS CLOSED. An unset or empty list means nobody is staff, not everybody —
 * the safe direction for a surface that lists every vendor's withheld
 * customer domains.
 */

/** Comma- or whitespace-separated Supabase auth user ids. */
export function staffUserIds(): string[] {
	return (process.env.STAFF_USER_IDS ?? "")
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter(Boolean);
}

export function staffAccessConfigured(): boolean {
	return staffUserIds().length > 0;
}

/**
 * Compared as opaque strings, case-sensitively. These are UUIDs from Supabase
 * and are only ever copied, never typed from memory, so normalising would buy
 * nothing and would widen what counts as a match.
 */
export function isStaffUser(userId: string | null | undefined): boolean {
	if (!userId) return false;
	return staffUserIds().includes(userId);
}
