import { NextResponse } from "next/server";
import { resolveAccessToken, type OAuthPrincipal } from "@/lib/oauth/core";
import type { Capability } from "@/lib/oauth/scopes";
import { isLetterstoryCaller } from "@/lib/auth/vendor-access";
import { findVendorByOrg } from "@/lib/fixtures/vendors";

/**
 * How a non-browser caller authenticates.
 *
 * Everything in this app so far is either fully public (the collector and proof
 * endpoints) or gated on a browser cookie session (src/proxy.ts). A CLI can
 * hold neither, so this is the third door: an `Authorization: Bearer` OAuth
 * access token minted by /api/oauth/token, resolved to the vendor it acts for.
 *
 * Bearer is the ONLY branch on purpose. The sister product also accepts a
 * static API key header, but this app has no api_keys table and inventing one
 * to mirror a shape we do not need yet would be a second credential system to
 * revoke, rotate, and audit. If CI ever needs a browserless credential, the
 * honest answer is a client_credentials grant on this same server, not a
 * parallel key store.
 */
const BEARER_PREFIX = "Bearer ";

export type OAuthAuthResult = { success: true; principal: OAuthPrincipal } | { success: false; response: NextResponse };

function unauthorized(): NextResponse {
	return NextResponse.json(
		{ error: "unauthorized" },
		// RFC 6750 §3: a 401 from a bearer-protected resource must say which
		// scheme it wants, otherwise a client cannot tell "wrong credential" from
		// "wrong endpoint".
		{ status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } },
	);
}

export async function authenticateOAuthRequest(request: Request): Promise<OAuthAuthResult> {
	const header = request.headers.get("authorization");
	if (!header?.startsWith(BEARER_PREFIX)) return { success: false, response: unauthorized() };

	const token = header.slice(BEARER_PREFIX.length).trim();
	if (!token) return { success: false, response: unauthorized() };

	const principal = await resolveAccessToken(token);
	if (!principal) return { success: false, response: unauthorized() };

	return { success: true, principal };
}

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
 * Authenticate a tool-dispatcher call from EITHER door:
 *  - Letterstory's backend, proven by the shared service secret, acting for the
 *    org named in the request body (`org_id`). Resolved to the vendor it is
 *    (findVendorByOrg); vendorId stays null in the pre-vendor case so the
 *    provisioning tools can still run.
 *  - a CLI/OAuth bearer token, exactly as before.
 *
 * `args` is the already-parsed request body — the org id lives there, so the
 * dispatcher parses the body before calling this.
 */
export async function authenticateToolRequest(request: Request, args: unknown): Promise<OAuthAuthResult> {
	if (!isLetterstoryCaller(request)) {
		return authenticateOAuthRequest(request);
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

/**
 * Scope check for a route that needs more than "a valid token". 403, not 401:
 * the credential is good, it just does not carry this capability — re-logging
 * in with the same grant would not help, so the client must not retry.
 */
export function requireCapability(principal: OAuthPrincipal, capability: Capability): OAuthAuthResult | null {
	if (principal.capabilities.includes(capability)) return null;
	return {
		success: false,
		response: NextResponse.json(
			{ error: "insufficient_scope", detail: capability },
			{ status: 403, headers: { "www-authenticate": `Bearer scope="${capability}"`, "cache-control": "no-store" } },
		),
	};
}
