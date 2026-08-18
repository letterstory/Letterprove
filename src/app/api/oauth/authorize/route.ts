import { NextResponse, type NextRequest } from "next/server";
import { getClient, checkRedirectUri, createPendingRequest, OAuthError } from "@/lib/oauth/core";
import { oauthErrorPage, oauthRedirectError } from "@/lib/oauth/responses";
import { oauthRateLimit, oauthClientIp } from "@/lib/oauth/ratelimit";
import { parseScope, formatScope, resolveGrantableScope, expandScopeWildcard } from "@/lib/oauth/scopes";

const CODE_CHALLENGE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * RFC 6749 §4.1.1 authorization endpoint. Renders no UI itself — it validates
 * the request, stores it as a pending row keyed by a fresh server-generated
 * nonce, then hands off to /oauth/consent, which owns the sign-in check and
 * the actual screen.
 */
export async function GET(request: NextRequest) {
	if (!(await oauthRateLimit(`authorize:${oauthClientIp(request)}`, 60, 30))) {
		return oauthErrorPage("Too many requests", "Please wait a moment and try again.");
	}

	const params = request.nextUrl.searchParams;
	const clientId = params.get("client_id");
	const redirectUri = params.get("redirect_uri");
	const responseType = params.get("response_type");
	const state = params.get("state");
	const codeChallenge = params.get("code_challenge");
	const codeChallengeMethod = params.get("code_challenge_method") ?? "S256";
	const requestedScope = params.get("scope");

	try {
		// client_id and redirect_uri problems can never be redirected onward: an
		// attacker who could steer this endpoint to an arbitrary URI would be
		// phishing through our own domain. Anything not validated against the
		// client's registered URIs renders here (RFC 6749 §4.1.2.1).
		if (!clientId) return oauthErrorPage("Invalid request", "Missing client_id.");

		const client = await getClient(clientId);
		if (!client) return oauthErrorPage("Unknown client", "This application is not registered.");

		if (!redirectUri || !checkRedirectUri(client, redirectUri)) {
			return oauthErrorPage("Invalid redirect_uri", "This redirect URI is not registered for this application.");
		}

		if (responseType !== "code") {
			return oauthRedirectError(
				redirectUri,
				"unsupported_response_type",
				"Only response_type=code is supported.",
				state ?? undefined,
			);
		}

		if (codeChallengeMethod !== "S256" || !codeChallenge || !CODE_CHALLENGE_RE.test(codeChallenge)) {
			return oauthRedirectError(
				redirectUri,
				"invalid_request",
				"A valid S256 code_challenge is required.",
				state ?? undefined,
			);
		}

		// A wildcard-registered client (the CLI) resolves against the CURRENT
		// capability set, not a snapshot frozen when its row was seeded — this is
		// the line that keeps a new capability from being silently withheld from
		// every login until someone notices. See expandScopeWildcard.
		const clientAllowed = expandScopeWildcard(client.allowed_scopes);
		const requested = requestedScope ? parseScope(requestedScope) : clientAllowed;
		const granted = resolveGrantableScope(requested, clientAllowed);
		if (granted.length === 0) {
			return oauthRedirectError(
				redirectUri,
				"invalid_scope",
				"None of the requested scopes are available.",
				state ?? undefined,
			);
		}

		const pending = await createPendingRequest({
			clientId: client.client_id,
			redirectUri,
			scope: formatScope(granted),
			state,
			codeChallenge,
		});

		const consentUrl = new URL("/oauth/consent", request.nextUrl.origin);
		consentUrl.searchParams.set("nonce", pending.nonce);
		return NextResponse.redirect(consentUrl);
	} catch (error) {
		if (error instanceof OAuthError) return oauthErrorPage("Something went wrong", error.message);
		return oauthErrorPage("Something went wrong", "Could not start the login. Please try again.");
	}
}
