import { NextResponse } from "next/server";
import type { Capability, OAuthPrincipal } from "@/lib/oauth/scopes";
import { isLetterstoryCaller } from "@/lib/auth/vendor-access";
import { findVendorByOrg } from "@/lib/fixtures/vendors";

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
 * the full vendor surface — but deliberately NOT staff:*, which is cross-vendor
 * power the org-scoped seam has no business holding (see record_customer).
 */
const LETTERSTORY_SERVICE_CAPABILITIES: Capability[] = ["vendor:read", "vendor:write"];

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
			capabilities: LETTERSTORY_SERVICE_CAPABILITIES,
			orgId,
		},
	};
}
