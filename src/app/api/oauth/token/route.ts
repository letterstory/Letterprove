import { type NextRequest } from "next/server";
import { authenticateClient, exchangeAuthorizationCode, exchangeRefreshToken, OAuthError } from "@/lib/oauth/core";
import { oauthErrorJson, tokenJson } from "@/lib/oauth/responses";
import { oauthRateLimit, oauthClientIp } from "@/lib/oauth/ratelimit";

/** RFC 6749 §3.2 token endpoint. Body is application/x-www-form-urlencoded. */
export async function POST(request: NextRequest) {
	if (!(await oauthRateLimit(`token:${oauthClientIp(request)}`, 60, 60))) {
		return oauthErrorJson("slow_down", "Too many requests.", 429);
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return oauthErrorJson("invalid_request", "Body must be application/x-www-form-urlencoded.");
	}

	const grantType = String(form.get("grant_type") ?? "");
	const clientId = String(form.get("client_id") ?? "");
	const clientSecret = form.get("client_secret");

	if (!clientId) return oauthErrorJson("invalid_client", "client_id is required.", 401);

	try {
		const client = await authenticateClient(clientId, clientSecret ? String(clientSecret) : null);

		if (grantType === "authorization_code") {
			const code = String(form.get("code") ?? "");
			const redirectUri = String(form.get("redirect_uri") ?? "");
			const codeVerifier = String(form.get("code_verifier") ?? "");
			if (!code || !redirectUri || !codeVerifier) {
				return oauthErrorJson("invalid_request", "code, redirect_uri, and code_verifier are required.");
			}
			return tokenResponse(
				await exchangeAuthorizationCode({ code, redirectUri, codeVerifier, clientId: client.client_id }),
			);
		}

		if (grantType === "refresh_token") {
			const refreshToken = String(form.get("refresh_token") ?? "");
			if (!refreshToken) return oauthErrorJson("invalid_request", "refresh_token is required.");
			return tokenResponse(await exchangeRefreshToken({ refreshToken, clientId: client.client_id }));
		}

		return oauthErrorJson("unsupported_grant_type", `Unsupported grant_type: ${grantType || "(missing)"}`);
	} catch (error) {
		if (error instanceof OAuthError) return oauthErrorJson(error.code, error.message, error.status);
		// Never echo an unexpected error to an unauthenticated caller — the token
		// endpoint sees attacker-controlled input by design.
		return oauthErrorJson("server_error", undefined, 500);
	}
}

function tokenResponse(tokens: { accessToken: string; refreshToken: string | null; scope: string; expiresIn: number }) {
	return tokenJson({
		access_token: tokens.accessToken,
		token_type: "Bearer",
		expires_in: tokens.expiresIn,
		scope: tokens.scope,
		...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
	});
}
