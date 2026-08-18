import { dbClient } from "@/lib/db/client";
import { redirectUriAllowed, verifyPkce, normalizeRedirectUri } from "./pkce";
import { parseScope, capabilitiesFromScope, OFFLINE_ACCESS, type Capability } from "./scopes";
import {
	generateAccessToken,
	generateRefreshToken,
	generateAuthorizationCode,
	generateFamilyId,
	generateNonce,
	hashToken,
	timingSafeEqualHex,
} from "./tokens";
import { encryptOAuthPayload, decryptOAuthPayload, oauthEncryptionConfigured } from "./encryption";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// How long after a rotation a repeated use of the OLD refresh token is treated
// as our own network retry (replay the cached successor) rather than theft
// (revoke the whole family). RFC 6819 §5.2.2.3 leaves the length to the
// implementer; a few seconds absorbs a client-side timeout-and-retry without
// giving a real attacker a meaningful grace period.
const REFRESH_REPLAY_WINDOW_SECONDS = 30;

export class OAuthError extends Error {
	code: string;
	status: number;
	constructor(code: string, description: string, status = 400) {
		super(description);
		this.code = code;
		this.status = status;
	}
}

/**
 * The service-role client, or a 500-shaped OAuthError when storage is not
 * configured. Unlike the collector — which accepts events with nowhere to put
 * them rather than failing a host page (see src/lib/http.ts) — auth has no safe
 * degraded mode: minting a token we cannot persist would hand out a credential
 * that verifies against nothing.
 */
function db() {
	const client = dbClient();
	if (!client) throw new OAuthError("server_error", "Authentication storage is not configured.", 500);
	return client;
}

export type OAuthClientRow = {
	client_id: string;
	name: string;
	client_type: string;
	redirect_uris: string[];
	allowed_scopes: string[];
	is_first_party: boolean;
};

export async function getClient(clientId: string): Promise<OAuthClientRow | null> {
	const { data } = await db()
		.from("oauth_clients")
		.select("client_id, name, client_type, redirect_uris, allowed_scopes, is_first_party")
		.eq("client_id", clientId)
		.maybeSingle<OAuthClientRow>();
	return data ?? null;
}

export function checkRedirectUri(client: OAuthClientRow, redirectUri: string): boolean {
	return redirectUriAllowed(client.redirect_uris, redirectUri);
}

/**
 * Public clients (the CLI, today) authenticate purely via PKCE — there is no
 * secret to check. The confidential branch is kept correct rather than assumed
 * unreachable, because `client_type` is a real column a future first-party
 * server-side integration could set.
 */
export async function authenticateClient(clientId: string, clientSecret?: string | null): Promise<OAuthClientRow> {
	const client = await getClient(clientId);
	if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);

	if (client.client_type === "confidential") {
		if (!clientSecret) throw new OAuthError("invalid_client", "client_secret is required for this client.", 401);
		const { data } = await db()
			.from("oauth_clients")
			.select("client_secret_hash")
			.eq("client_id", clientId)
			.maybeSingle<{ client_secret_hash: string | null }>();
		const expected = data?.client_secret_hash;
		if (!expected || !timingSafeEqualHex(hashToken(clientSecret), expected)) {
			throw new OAuthError("invalid_client", "Invalid client credentials.", 401);
		}
	}

	return client;
}

// ---------------------------------------------------------------------------
// Pending authorization requests
// ---------------------------------------------------------------------------

export type PendingRequest = {
	id: string;
	nonce: string;
	client_id: string;
	vendor_id: string | null;
	user_id: string | null;
	redirect_uri: string;
	scope: string;
	state: string | null;
	code_challenge: string;
	code_challenge_method: string;
	status: string;
	expires_at: string;
};

export async function createPendingRequest(params: {
	clientId: string;
	redirectUri: string;
	scope: string;
	state: string | null;
	codeChallenge: string;
}): Promise<PendingRequest> {
	const { data, error } = await db()
		.from("oauth_pending_requests")
		.insert({
			nonce: generateNonce(),
			client_id: params.clientId,
			redirect_uri: params.redirectUri,
			scope: params.scope,
			state: params.state,
			code_challenge: params.codeChallenge,
		})
		.select()
		.single<PendingRequest>();
	if (error || !data) throw new OAuthError("server_error", "Could not start the login request.", 500);
	return data;
}

export async function getPendingRequest(nonce: string): Promise<PendingRequest | null> {
	const { data } = await db()
		.from("oauth_pending_requests")
		.select("*")
		.eq("nonce", nonce)
		.maybeSingle<PendingRequest>();
	if (!data) return null;
	if (new Date(data.expires_at).getTime() < Date.now()) return null;
	if (data.status !== "pending" && data.status !== "claimed") return null;
	return data;
}

/**
 * Run right after the user signs in (or immediately, if they already were) so
 * the consent screen renders from a server-persisted binding rather than from
 * a client-submitted user id.
 */
export async function claimPendingForUser(nonce: string, userId: string): Promise<PendingRequest | null> {
	const { data } = await db()
		.from("oauth_pending_requests")
		.update({ user_id: userId, status: "claimed" })
		.eq("nonce", nonce)
		.in("status", ["pending", "claimed"])
		.gt("expires_at", new Date().toISOString())
		.select()
		.maybeSingle<PendingRequest>();
	return data ?? null;
}

/**
 * Single-use consumption at the consent POST. `vendorId` is whatever the
 * caller resolved the user's vendor choice to — and the route MUST verify that
 * membership itself before calling this, never trusting a form field.
 */
export async function consumePendingForConsent(
	nonce: string,
	userId: string,
	vendorId: string,
): Promise<PendingRequest | null> {
	const { data } = await db()
		.from("oauth_pending_requests")
		.update({ status: "consumed", vendor_id: vendorId })
		.eq("nonce", nonce)
		.eq("user_id", userId)
		.eq("status", "claimed")
		.gt("expires_at", new Date().toISOString())
		.select()
		.maybeSingle<PendingRequest>();
	return data ?? null;
}

export async function denyPendingRequest(nonce: string, userId: string): Promise<PendingRequest | null> {
	const { data } = await db()
		.from("oauth_pending_requests")
		.update({ status: "consumed" })
		.eq("nonce", nonce)
		.eq("user_id", userId)
		.in("status", ["pending", "claimed"])
		.select()
		.maybeSingle<PendingRequest>();
	return data ?? null;
}

// ---------------------------------------------------------------------------
// Authorization + code issuance
// ---------------------------------------------------------------------------

export type AuthorizationRow = {
	id: string;
	client_id: string;
	vendor_id: string;
	user_id: string;
	scope: string;
};

/**
 * Re-consenting REPLACES the prior grant's scope rather than unioning with it —
 * the consent screen shows exactly what will be granted, so narrowing on
 * re-consent has to actually narrow.
 *
 * `updated_at` is set here rather than by a trigger: this schema has no shared
 * `handle_updated_at()` helper, and inventing one for a single table would be a
 * wider change than this step warrants.
 */
export async function upsertAuthorization(params: {
	clientId: string;
	vendorId: string;
	userId: string;
	scope: string;
}): Promise<AuthorizationRow> {
	const { data, error } = await db()
		.from("oauth_authorizations")
		.upsert(
			{
				client_id: params.clientId,
				vendor_id: params.vendorId,
				user_id: params.userId,
				scope: params.scope,
				revoked_at: null,
				updated_at: new Date().toISOString(),
			},
			{ onConflict: "client_id,vendor_id,user_id" },
		)
		.select("id, client_id, vendor_id, user_id, scope")
		.single<AuthorizationRow>();
	if (error || !data) throw new OAuthError("server_error", "Could not record the authorization.", 500);
	return data;
}

export async function issueAuthorizationCode(params: {
	authorizationId: string;
	redirectUri: string;
	codeChallenge: string;
	scope: string;
}): Promise<string> {
	const code = generateAuthorizationCode();
	const { error } = await db().from("oauth_authorization_codes").insert({
		code_hash: hashToken(code),
		authorization_id: params.authorizationId,
		redirect_uri: params.redirectUri,
		code_challenge: params.codeChallenge,
		scope: params.scope,
	});
	if (error) throw new OAuthError("server_error", "Could not issue the authorization code.", 500);
	return code;
}

// ---------------------------------------------------------------------------
// Token minting, exchange, rotation, revocation
// ---------------------------------------------------------------------------

export type TokenPair = {
	accessToken: string;
	refreshToken: string | null;
	scope: string;
	expiresIn: number;
};

async function mintTokenPair(params: {
	authorizationId: string;
	vendorId: string;
	scope: string;
	familyId?: string;
}): Promise<TokenPair> {
	const client = db();
	const accessToken = generateAccessToken();
	const issueRefresh = parseScope(params.scope).includes(OFFLINE_ACCESS);

	const { error: atError } = await client.from("oauth_access_tokens").insert({
		token_hash: hashToken(accessToken),
		authorization_id: params.authorizationId,
		vendor_id: params.vendorId,
		scope: params.scope,
		expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
	});
	if (atError) throw new OAuthError("server_error", "Could not mint an access token.", 500);

	let refreshToken: string | null = null;
	if (issueRefresh) {
		refreshToken = generateRefreshToken();
		const { error: rtError } = await client.from("oauth_refresh_tokens").insert({
			token_hash: hashToken(refreshToken),
			family_id: params.familyId ?? generateFamilyId(),
			authorization_id: params.authorizationId,
			vendor_id: params.vendorId,
			scope: params.scope,
			expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
		});
		if (rtError) throw new OAuthError("server_error", "Could not mint a refresh token.", 500);
	}

	return { accessToken, refreshToken, scope: params.scope, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

type AuthorizationCodeRow = {
	id: string;
	authorization_id: string;
	redirect_uri: string;
	code_challenge: string;
	code_challenge_method: string;
	scope: string;
	consumed_at: string | null;
	expires_at: string;
};

type AuthorizationLookupRow = {
	id: string;
	client_id: string;
	vendor_id: string;
	revoked_at: string | null;
};

export async function exchangeAuthorizationCode(params: {
	code: string;
	redirectUri: string;
	codeVerifier: string;
	clientId: string;
}): Promise<TokenPair> {
	const client = db();

	const { data: codeRow } = await client
		.from("oauth_authorization_codes")
		.select(
			"id, authorization_id, redirect_uri, code_challenge, code_challenge_method, scope, consumed_at, expires_at",
		)
		.eq("code_hash", hashToken(params.code))
		.maybeSingle<AuthorizationCodeRow>();

	if (!codeRow) throw new OAuthError("invalid_grant", "Unknown or already-used authorization code.");
	if (codeRow.consumed_at) throw new OAuthError("invalid_grant", "This authorization code has already been used.");
	if (new Date(codeRow.expires_at).getTime() < Date.now()) {
		throw new OAuthError("invalid_grant", "This authorization code has expired.");
	}
	if (normalizeRedirectUri(codeRow.redirect_uri) !== normalizeRedirectUri(params.redirectUri)) {
		throw new OAuthError("invalid_grant", "redirect_uri does not match the original request.");
	}
	if (!verifyPkce(params.codeVerifier, codeRow.code_challenge, codeRow.code_challenge_method)) {
		throw new OAuthError("invalid_grant", "code_verifier does not match.");
	}

	const { data: authRow } = await client
		.from("oauth_authorizations")
		.select("id, client_id, vendor_id, revoked_at")
		.eq("id", codeRow.authorization_id)
		.maybeSingle<AuthorizationLookupRow>();
	if (!authRow || authRow.revoked_at) throw new OAuthError("invalid_grant", "This authorization is no longer valid.");
	if (authRow.client_id !== params.clientId) {
		throw new OAuthError("invalid_grant", "This code was not issued to this client.");
	}

	// Mark consumed FIRST, and mint only if this update actually claimed the row
	// (zero rows = a concurrent request already took it). Closes the race where
	// two token requests for one code both pass the checks above before either
	// writes back — which would hand out two live sessions for one login.
	const { data: claimed } = await client
		.from("oauth_authorization_codes")
		.update({ consumed_at: new Date().toISOString() })
		.eq("id", codeRow.id)
		.is("consumed_at", null)
		.select("id")
		.maybeSingle<{ id: string }>();
	if (!claimed) throw new OAuthError("invalid_grant", "This authorization code has already been used.");

	return mintTokenPair({ authorizationId: authRow.id, vendorId: authRow.vendor_id, scope: codeRow.scope });
}

type RefreshTokenRow = {
	id: string;
	family_id: string;
	authorization_id: string;
	vendor_id: string;
	scope: string;
	used_at: string | null;
	expires_at: string;
	revoked_at: string | null;
	successor_hash: string | null;
	encrypted_successor: string | null;
};

export async function exchangeRefreshToken(params: { refreshToken: string; clientId: string }): Promise<TokenPair> {
	const client = db();

	const { data: rtRow } = await client
		.from("oauth_refresh_tokens")
		.select(
			"id, family_id, authorization_id, vendor_id, scope, used_at, expires_at, revoked_at, successor_hash, encrypted_successor",
		)
		.eq("token_hash", hashToken(params.refreshToken))
		.maybeSingle<RefreshTokenRow>();

	if (!rtRow) throw new OAuthError("invalid_grant", "Unknown refresh token.");
	if (rtRow.revoked_at) throw new OAuthError("invalid_grant", "This refresh token has been revoked.");
	if (new Date(rtRow.expires_at).getTime() < Date.now()) {
		throw new OAuthError("invalid_grant", "This refresh token has expired.");
	}

	const { data: authRow } = await client
		.from("oauth_authorizations")
		.select("id, client_id, vendor_id, revoked_at")
		.eq("id", rtRow.authorization_id)
		.maybeSingle<AuthorizationLookupRow>();
	if (!authRow || authRow.revoked_at) throw new OAuthError("invalid_grant", "This authorization is no longer valid.");
	if (authRow.client_id !== params.clientId) {
		throw new OAuthError("invalid_grant", "This token was not issued to this client.");
	}

	if (rtRow.used_at) {
		const usedMsAgo = Date.now() - new Date(rtRow.used_at).getTime();
		if (usedMsAgo <= REFRESH_REPLAY_WINDOW_SECONDS * 1000 && rtRow.encrypted_successor) {
			try {
				return JSON.parse(decryptOAuthPayload(rtRow.encrypted_successor)) as TokenPair;
			} catch {
				// Cache unreadable (key rotated or unset) — fall through to reuse handling.
			}
		}
		// Reuse outside the replay window: this token was already rotated once, so
		// a second use means it leaked. Revoke the whole family (RFC 6819 §5.2.2.3).
		await revokeFamily(rtRow.family_id);
		throw new OAuthError("invalid_grant", "This refresh token has already been used.");
	}

	const successor = await mintTokenPair({
		authorizationId: authRow.id,
		vendorId: authRow.vendor_id,
		scope: rtRow.scope,
		familyId: rtRow.family_id,
	});

	await client
		.from("oauth_refresh_tokens")
		.update({
			used_at: new Date().toISOString(),
			successor_hash: successor.refreshToken ? hashToken(successor.refreshToken) : null,
			// Skipped rather than weakly encrypted when no key is configured; see
			// encryption.ts. The cost is that a retried refresh reads as reuse.
			encrypted_successor: oauthEncryptionConfigured() ? encryptOAuthPayload(JSON.stringify(successor)) : null,
		})
		.eq("id", rtRow.id)
		.is("used_at", null);

	return successor;
}

export async function revokeFamily(familyId: string): Promise<void> {
	await db()
		.from("oauth_refresh_tokens")
		.update({ revoked_at: new Date().toISOString() })
		.eq("family_id", familyId)
		.is("revoked_at", null);
}

/**
 * RFC 7009: revocation always succeeds from the caller's perspective —
 * possession of the token is sufficient authorization to revoke it, and we
 * never confirm or deny whether an unrecognized token ever existed.
 */
export async function revokeByToken(token: string): Promise<void> {
	const client = db();
	const tokenHash = hashToken(token);

	await client
		.from("oauth_access_tokens")
		.update({ revoked_at: new Date().toISOString() })
		.eq("token_hash", tokenHash)
		.is("revoked_at", null);

	const { data: rtRow } = await client
		.from("oauth_refresh_tokens")
		.select("family_id")
		.eq("token_hash", tokenHash)
		.maybeSingle<{ family_id: string }>();
	if (rtRow) await revokeFamily(rtRow.family_id);
}

// ---------------------------------------------------------------------------
// Resolving a bearer access token to a principal, for src/lib/oauth-auth.ts
// ---------------------------------------------------------------------------

export type OAuthPrincipal = {
	tokenId: string;
	vendorId: string;
	userId: string;
	capabilities: Capability[];
};

export async function resolveAccessToken(token: string): Promise<OAuthPrincipal | null> {
	const client = db();

	const { data: tokenRow } = await client
		.from("oauth_access_tokens")
		.select("id, vendor_id, scope, expires_at, revoked_at, authorization_id")
		.eq("token_hash", hashToken(token))
		.maybeSingle<{
			id: string;
			vendor_id: string;
			scope: string;
			expires_at: string;
			revoked_at: string | null;
			authorization_id: string;
		}>();
	if (!tokenRow || tokenRow.revoked_at) return null;
	if (new Date(tokenRow.expires_at).getTime() < Date.now()) return null;

	// The grant can be revoked without touching every token it minted, so the
	// authorization is re-checked on every call rather than trusted from mint time.
	const { data: authRow } = await client
		.from("oauth_authorizations")
		.select("user_id, revoked_at")
		.eq("id", tokenRow.authorization_id)
		.maybeSingle<{ user_id: string; revoked_at: string | null }>();
	if (!authRow || authRow.revoked_at) return null;

	await client.from("oauth_access_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", tokenRow.id);

	return {
		tokenId: tokenRow.id,
		vendorId: tokenRow.vendor_id,
		userId: authRow.user_id,
		capabilities: capabilitiesFromScope(parseScope(tokenRow.scope)),
	};
}
