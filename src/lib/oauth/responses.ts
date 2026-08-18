import { NextResponse } from "next/server";

export function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * A dependency-free error page for the cases where we deliberately do NOT
 * redirect back to the client (unregistered redirect_uri, unknown client_id).
 * RFC 6749 §4.1.2.1: the authorization server must render those itself rather
 * than reflect them to a redirect URI it never validated — otherwise an
 * attacker registers a lookalike client and phishes through our own domain.
 */
export function oauthErrorPage(title: string, message: string): NextResponse {
	const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</body></html>`;
	return new NextResponse(html, { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** RFC 6749 §4.1.2.1: redirect back to the client with error/error_description/state. */
export function oauthRedirectError(
	redirectUri: string,
	error: string,
	description?: string,
	state?: string,
): NextResponse {
	const url = new URL(redirectUri);
	url.searchParams.set("error", error);
	if (description) url.searchParams.set("error_description", description);
	if (state) url.searchParams.set("state", state);
	return NextResponse.redirect(url.toString());
}

/**
 * RFC 6749 §5.2 JSON error body for the token/revoke endpoints. `no-store` is
 * required by §5.1 and matters here for the same reason the proof endpoints
 * are aggressively cached and these are not: a cached credential response is a
 * credential handed to the next caller.
 */
export function oauthErrorJson(error: string, description?: string, status = 400): NextResponse {
	return NextResponse.json(
		{ error, ...(description ? { error_description: description } : {}) },
		{ status, headers: { "cache-control": "no-store", pragma: "no-cache" } },
	);
}

export function tokenJson(body: Record<string, unknown>): NextResponse {
	return NextResponse.json(body, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
}
