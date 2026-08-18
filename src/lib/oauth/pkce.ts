import { createHash, timingSafeEqual } from "node:crypto";

// RFC 7636 §4.1: 43-128 chars from the unreserved URI charset.
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function validCodeVerifier(verifier: string): boolean {
	return CODE_VERIFIER_RE.test(verifier);
}

function base64url(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Verifies a PKCE code_verifier against the code_challenge stored at
 * /authorize time. Only S256 is accepted — OAuth 2.1 drops the "plain" method
 * entirely. The comparison is constant-time so a timing side-channel cannot
 * shrink the search space for an attacker racing the code exchange.
 */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
	if (method !== "S256") return false;
	if (!validCodeVerifier(verifier)) return false;
	const computed = base64url(createHash("sha256").update(verifier).digest());
	const a = Buffer.from(computed);
	const b = Buffer.from(challenge);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function isLoopbackHttp(url: URL): boolean {
	return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Loopback redirect_uris can arrive spelled differently (127.0.0.1 vs
 * localhost) depending on what sits between the CLI and this app — a preview
 * deployment has been observed rewriting one to the other ahead of the app.
 * Collapse to a canonical form so the exact-match comparison at token exchange
 * is not tripped by that variance. Non-loopback URIs pass through untouched,
 * since those must still match byte-for-byte.
 */
export function normalizeRedirectUri(uri: string): string {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return uri;
	}
	if (!isLoopbackHttp(parsed)) return uri;
	return `http://127.0.0.1:${parsed.port}${parsed.pathname}`;
}

/**
 * RFC 8252 §7.3: native-app loopback redirects are matched on scheme + host +
 * path only — the port is chosen ephemerally per login attempt, so a public
 * client registers loopback entries with no port (e.g. "http://127.0.0.1/callback")
 * and any port is accepted at request time. Everything else must match exactly.
 */
export function redirectUriAllowed(registeredUris: string[], requestedUri: string): boolean {
	let requested: URL;
	try {
		requested = new URL(requestedUri);
	} catch {
		return false;
	}

	if (isLoopbackHttp(requested)) {
		// Node's URL.hostname already includes the brackets for IPv6 ("[::1]"),
		// so this is a plain scheme+host+path template with the port stripped.
		const host = requested.hostname === "localhost" ? "127.0.0.1" : requested.hostname;
		return registeredUris.includes(`http://${host}${requested.pathname}`);
	}

	return registeredUris.includes(requestedUri);
}
