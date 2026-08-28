import { NextResponse } from "next/server";
import type { Capability, OAuthPrincipal } from "@/lib/oauth/scopes";
import { isLetterstoryCaller } from "@/lib/auth/vendor-access";
import { findVendorByOrg } from "@/lib/fixtures/vendors";
import { isStaffUser } from "@/lib/staff/allowlist";

/**
 * How a non-browser caller authenticates.
 *
 * There is exactly ONE door now: Letterstory's backend, proven by the shared
 * service secret. Letterprove holds no identity of its own in the unified
 * model — its dashboard, login, and OAuth server (the CLI's bearer tokens) are
 * retired — so a caller that is not Letterstory's backend is refused outright.
 * The public collector and proof endpoints stay open on their own; this seam
 * only governs the vendor-scoped tool dispatcher.
 */

export type OAuthAuthResult = { success: true; principal: OAuthPrincipal } | { success: false; response: NextResponse };

/**
 * Sentinel principal identity for a Letterstory-service call. There is no
 * access-token row behind it — the caller is Letterstory's backend proven by
 * the shared service secret, not a minted bearer token — so tokenId/userId that
 * would normally key an oauth row carry this marker instead. `userId` is
 * overridden by a trusted `user_id` in the call when Letterstory sends one, so
 * a write can still be attributed to the acting human.
 */
export const LETTERSTORY_SERVICE_IDENTITY = "letterstory-service";

/**
 * The vendor capabilities a Letterstory-service principal carries. Role gating
 * (admin vs editor) already happened in Letterstory before the call, so this is
 * the full vendor surface.
 */
const LETTERSTORY_SERVICE_CAPABILITIES: Capability[] = ["vendor:read", "vendor:write"];

/**
 * Cross-vendor capabilities, added only for an acting human this deployment
 * has independently named as staff.
 *
 * Retiring Letterprove's own dashboard took the staff views with it, and the
 * OAuth path that used to carry staff scopes is gone — so after #124 the two
 * staff tools (`tier_report`, `record_customer`) existed in the registry with
 * no caller in the world able to reach them. Cross-vendor work had no home at
 * all, which is a gap rather than a decision.
 *
 * The original comment here said staff:* is "cross-vendor power the org-scoped
 * seam has no business holding", and that instinct is right about the SEAM: a
 * secret proving "this is Letterstory's backend" says nothing about who is
 * sitting in front of it. What makes this safe is that the grant is not
 * attached to the seam at all. It is attached to the acting user, and the
 * decision is made HERE:
 *
 *   - Letterstory sends the acting human's user id (already trusted, already
 *     used for write attribution).
 *   - Letterprove checks it against its OWN staff allowlist and grants
 *     nothing if it doesn't match.
 *
 * The alternative — Letterstory asserting `staff: true` and Letterprove
 * believing it — was rejected. It would make every cross-vendor read
 * contingent on Letterstory never having a bug in its own internal-user check,
 * and it would mean this deployment could not revoke staff access without
 * someone else shipping. Neither is a property to give up for one boolean.
 *
 * This is not a defence against a compromised Letterstory: whoever holds the
 * shared secret can name any user id they like. It defends against the
 * realistic failure, which is a mistake on the other side of the seam, and it
 * keeps Letterprove's most sensitive surface revocable from Letterprove.
 *
 * Fails closed, inheriting isStaffUser: an unset STAFF_USER_IDS means nobody
 * is staff, so a deployment that has not named its staff serves no staff
 * surface at all.
 *
 * NOTE the allowlist now holds LETTERSTORY user ids, not Letterprove ones —
 * Letterprove no longer has a user pool. Still ids and not emails, for the
 * reason allowlist.ts gives at length: an address is not something either app
 * verifies ownership of.
 */
const STAFF_CAPABILITIES: Capability[] = ["staff:read", "staff:write"];

function capabilitiesFor(userId: string): Capability[] {
	// The sentinel means "this call named no human". It must never be
	// allowlistable into staff, or a misconfigured STAFF_USER_IDS containing it
	// would hand cross-vendor read and write to every call that simply omits
	// user_id — the widest possible grant, attributable to nobody. `record_customer`
	// writes to another vendor's data; that has to trace back to a person.
	if (!userId || userId === LETTERSTORY_SERVICE_IDENTITY) return LETTERSTORY_SERVICE_CAPABILITIES;

	return isStaffUser(userId)
		? [...LETTERSTORY_SERVICE_CAPABILITIES, ...STAFF_CAPABILITIES]
		: LETTERSTORY_SERVICE_CAPABILITIES;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Authenticate a tool-dispatcher call from Letterstory's backend, proven by the
 * shared service secret, acting for the org named in the request body
 * (`org_id`). Resolved to the vendor it is (findVendorByOrg); vendorId stays
 * null in the pre-vendor case so the provisioning tools can still run.
 *
 * A caller that is not Letterstory's backend gets a 401 — there is no OAuth
 * fallback anymore.
 *
 * `args` is the already-parsed request body — the org id lives there, so the
 * dispatcher parses the body before calling this.
 */
export async function authenticateToolRequest(request: Request, args: unknown): Promise<OAuthAuthResult> {
	if (!isLetterstoryCaller(request)) {
		return {
			success: false,
			response: NextResponse.json(
				{ error: "unauthorized" },
				{ status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } },
			),
		};
	}

	const body = asRecord(args);
	const orgId = typeof body.org_id === "string" ? body.org_id.trim() : "";
	if (!orgId) {
		return {
			success: false,
			response: NextResponse.json(
				{ error: "invalid_request", detail: "org_id is required" },
				{ status: 400, headers: { "cache-control": "no-store" } },
			),
		};
	}

	const vendor = await findVendorByOrg(orgId);
	const userId = typeof body.user_id === "string" && body.user_id.trim() ? body.user_id.trim() : LETTERSTORY_SERVICE_IDENTITY;

	return {
		success: true,
		principal: {
			tokenId: LETTERSTORY_SERVICE_IDENTITY,
			vendorId: vendor?.id ?? null,
			userId,
			capabilities: capabilitiesFor(userId),
			orgId,
		},
	};
}
