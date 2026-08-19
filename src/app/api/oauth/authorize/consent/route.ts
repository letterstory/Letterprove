import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/auth/server";
import {
	getPendingRequest,
	consumePendingForConsent,
	denyPendingRequest,
	upsertAuthorization,
	issueAuthorizationCode,
} from "@/lib/oauth/core";
import { oauthErrorPage, oauthRedirectError } from "@/lib/oauth/responses";
import { oauthRateLimit, oauthClientIp } from "@/lib/oauth/ratelimit";
import { parseScope, formatScope, isVendorScoped } from "@/lib/oauth/scopes";
import { vendorMemberships } from "@/lib/vendors/session";

/**
 * Handles the plain HTML form POST from /oauth/consent.
 *
 * Deliberately not a JSON endpoint: the browser follows this response's
 * redirect straight to the CLI's loopback listener with no client-side
 * JavaScript in the loop, which is what makes the handoff work in a terminal
 * user's default browser regardless of what that browser is.
 */
export async function POST(request: NextRequest) {
	if (!(await oauthRateLimit(`consent:${oauthClientIp(request)}`, 60, 30))) {
		return oauthErrorPage("Too many requests", "Please wait a moment and try again.");
	}

	const supabase = await createServerSupabaseClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return oauthErrorPage("Session expired", "Please sign in again and restart the login.");

	const form = await request.formData();
	const nonce = String(form.get("nonce") ?? "");
	const vendorId = String(form.get("vendor_id") ?? "");
	const decision = String(form.get("decision") ?? "");

	// The pending row — not the form — is the source of truth for redirect_uri,
	// scope, state, and code_challenge. The form contributes only the nonce, the
	// vendor choice (verified below), and the yes/no.
	const pending = await getPendingRequest(nonce);
	if (!pending || pending.user_id !== user.id) {
		return oauthErrorPage("Invalid request", "This login request has expired or is invalid. Please try again.");
	}

	if (decision !== "allow") {
		await denyPendingRequest(nonce, user.id);
		return oauthRedirectError(
			pending.redirect_uri,
			"access_denied",
			"The user denied the request.",
			pending.state ?? undefined,
		);
	}

	// The CLI client is registered with the `*` wildcard, so an ordinary
	// `letterprove login` requests every scope this server knows about —
	// vendor:* and staff:* alike — regardless of who's signing in. Consent
	// used to narrow the grant by membership/allowlist here; it no longer
	// does. Grant whatever was requested and let dispatchTool (registry.ts)
	// verify vendor membership and staff status fresh on every call instead —
	// one enforcement point for both capability classes, checked against
	// current state rather than baked into the token at mint time. See
	// project_letterprove-cli-controllable for why (Steve, 2026-08-19).
	const requested = parseScope(pending.scope);

	// vendor:* still needs to know WHICH vendor the token acts on — that's a
	// routing question dispatchTool can't answer on its own, not a permission
	// check, so it stays here. Whether vendorId is one this user actually
	// belongs to is exactly what dispatchTool re-verifies on every call.
	//
	// The CLI always requests the full wildcard scope, so a pure-staff user
	// with zero vendor accounts would otherwise hit "select a vendor" with no
	// vendor to select — a dead end. When there's truly nothing to pick from,
	// drop vendor:* from the grant instead of erroring, same as an unsupported
	// scope is dropped in resolveGrantableScope.
	let resolvedVendorId: string | null = null;
	let grantScope = requested;
	if (requested.some(isVendorScoped)) {
		const vendors = await vendorMemberships();
		if (vendors.length === 0) {
			grantScope = requested.filter((s) => !isVendorScoped(s));
		} else if (!vendorId) {
			return oauthErrorPage("Not authorized", "Select a vendor to continue.");
		} else {
			resolvedVendorId = vendorId;
		}
	}

	if (grantScope.length === 0) {
		return oauthErrorPage("Not authorized", "You don't have access to any of the requested permissions.");
	}

	const consumed = await consumePendingForConsent(nonce, user.id, resolvedVendorId);
	if (!consumed) return oauthErrorPage("Invalid request", "This login request has already been used or has expired.");

	const grantedScope = formatScope(grantScope);

	try {
		const authorization = await upsertAuthorization({
			clientId: consumed.client_id,
			vendorId: resolvedVendorId,
			userId: user.id,
			scope: grantedScope,
		});
		const code = await issueAuthorizationCode({
			authorizationId: authorization.id,
			redirectUri: consumed.redirect_uri,
			codeChallenge: consumed.code_challenge,
			scope: grantedScope,
		});

		const redirectUrl = new URL(consumed.redirect_uri);
		redirectUrl.searchParams.set("code", code);
		if (consumed.state) redirectUrl.searchParams.set("state", consumed.state);
		return NextResponse.redirect(redirectUrl.toString());
	} catch {
		return oauthErrorPage("Something went wrong", "Could not complete the login. Please try again.");
	}
}
