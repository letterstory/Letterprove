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

	// Membership is checked through the session-bound client, so RLS scopes the
	// select to auth.uid() — a row coming back really does mean "this user
	// belongs to this vendor", not "this vendor exists".
	const { data: membership } = await supabase
		.from("vendor_members")
		.select("vendor_id")
		.eq("vendor_id", vendorId)
		.maybeSingle();
	if (!membership) return oauthErrorPage("Not authorized", "You are not a member of the selected vendor.");

	const consumed = await consumePendingForConsent(nonce, user.id, vendorId);
	if (!consumed) return oauthErrorPage("Invalid request", "This login request has already been used or has expired.");

	try {
		const authorization = await upsertAuthorization({
			clientId: consumed.client_id,
			vendorId,
			userId: user.id,
			scope: consumed.scope,
		});
		const code = await issueAuthorizationCode({
			authorizationId: authorization.id,
			redirectUri: consumed.redirect_uri,
			codeChallenge: consumed.code_challenge,
			scope: consumed.scope,
		});

		const redirectUrl = new URL(consumed.redirect_uri);
		redirectUrl.searchParams.set("code", code);
		if (consumed.state) redirectUrl.searchParams.set("state", consumed.state);
		return NextResponse.redirect(redirectUrl.toString());
	} catch {
		return oauthErrorPage("Something went wrong", "Could not complete the login. Please try again.");
	}
}
