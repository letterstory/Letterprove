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

	// Mirrors the narrowing in /oauth/consent: the CLI's default login requests
	// every scope its client is registered for, which today always includes
	// vendor:* — recomputed here independently of the form (never trusting a
	// client-submitted vendor_id or its absence as a security boundary). A user
	// with no vendor memberships silently drops vendor:* from the grant instead
	// of erroring; a user who does have memberships must submit one they
	// actually belong to.
	const requested = parseScope(pending.scope);
	const vendors = await vendorMemberships();
	let resolvedVendorId: string | null = null;
	let grantScope = requested;

	if (vendors.length > 0 && requested.some(isVendorScoped)) {
		const { data: membership } = await supabase
			.from("vendor_members")
			.select("vendor_id")
			.eq("vendor_id", vendorId)
			.maybeSingle();
		if (!membership) return oauthErrorPage("Not authorized", "You are not a member of the selected vendor.");
		resolvedVendorId = vendorId;
	} else {
		grantScope = requested.filter((s) => !isVendorScoped(s));
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
