import { NextResponse } from "next/server";
import { KNOWN_SCOPES } from "@/lib/oauth/scopes";

/**
 * RFC 8414 authorization-server metadata, served at
 * /.well-known/oauth-authorization-server.
 *
 * The CLI does not need this — it hardcodes /api/oauth/authorize and
 * /api/oauth/token, which is fine for a client shipped from this same repo.
 * Every OTHER client is the point. An MCP client, or any generic OAuth
 * library, is handed a base URL and expects to discover the endpoints; without
 * this document its only options are to be told each path out of band or to
 * guess. The tool registry already names MCP as the next transport over the
 * same seam, so this is the difference between "point it at the URL" and "here
 * is a paragraph of setup instructions".
 *
 * It is the same argument as /.well-known/letterprove.json, which exists so an
 * agent can go from a host to a verified claim without reading our docs. This
 * does it for authorization instead of proof.
 *
 * Every value here is DERIVED or asserted from what the routes actually
 * enforce, never aspirational — a metadata document that advertises a grant
 * the server rejects is worse than no document, because a client will believe
 * it. Specifically:
 *
 *   - `code` only: authorize/route.ts rejects every other response_type.
 *   - `S256` only, never `plain`: authorize/route.ts requires it explicitly,
 *     which is what RFC 8252 wants for a native app.
 *   - `none` for client auth: the CLI is a public client and authenticates by
 *     PKCE alone (see authenticateClient). `client_secret_post` is listed too
 *     because the confidential branch is implemented, not merely planned, and
 *     reads the secret from the form body rather than the Authorization header.
 *   - scopes come from KNOWN_SCOPES, so adding a capability updates this
 *     document automatically. Writing the list out here would reintroduce
 *     exactly the staleness the ALL_SCOPES_WILDCARD sentinel exists to avoid.
 */
export function GET(request: Request) {
	const origin = new URL(request.url).origin;

	return NextResponse.json(
		{
			issuer: origin,
			authorization_endpoint: `${origin}/api/oauth/authorize`,
			token_endpoint: `${origin}/api/oauth/token`,
			revocation_endpoint: `${origin}/api/oauth/revoke`,
			scopes_supported: [...KNOWN_SCOPES],
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
			revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
			service_documentation: "https://github.com/letterstory/Letterprove#readme",
		},
		{
			headers: {
				// Public, cacheable, and readable cross-origin for the same reason
				// the proof endpoints are: a discovery document a client cannot
				// fetch from a browser context is not discovery.
				"cache-control": "public, max-age=3600",
				"access-control-allow-origin": "*",
			},
		}
	);
}
