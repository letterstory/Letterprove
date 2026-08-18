import { NextResponse } from "next/server";
import { resolveAccessToken, type OAuthPrincipal } from "@/lib/oauth/core";
import type { Capability } from "@/lib/oauth/scopes";

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
