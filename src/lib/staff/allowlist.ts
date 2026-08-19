/**
 * Who counts as staff.
 *
 * This existed nowhere until now, and its absence was a live disclosure. The
 * staff wall in proxy.ts only asked whether a request carried *a* session:
 *
 *   - /staff/login offers self-service signup,
 *   - Supabase has `disable_signup: false` and `mailer_autoconfirm: true`, so
 *     registering returns a usable session immediately with no email
 *     confirmation,
 *   - staff and vendor share one user pool (see proxy.ts),
 *
 * so anyone on the internet could register and read /staff/tiers, which lists
 * every vendor's withheld customer domains — the exact data the consent model
 * exists to protect. tiers/report.ts says of its own output: "this output is
 * staff-only and must never be served unauthenticated." It was authenticated,
 * by anyone.
 *
 * The vendor wall never had this problem because it demands a `vendor_members`
 * row, on the stated grounds that "signing in alone only proves *a* user, not
 * *which* vendor". Staff needed the same sentence applied to it.
 *
 * USER IDS, NOT EMAILS. An email allowlist is not a gate while signup is open:
 * anyone able to register an allowlisted address inherits staff, and address
 * ownership is not something this app verifies. The sibling product settled on
 * the same answer for the same reason.
 *
 * FAILS CLOSED. An unset or empty list means nobody is staff, not everybody.
 * The consequence is deliberate: a deployment that has not been told who its
 * staff are serves no staff surfaces at all, which is the safe direction for
 * an internal area — proxy.ts already argues exactly this for missing auth
 * config. A self-hosted install therefore gets no staff surface until its
 * operator names one.
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
