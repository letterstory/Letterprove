// These two functions are what stands between an intercepted authorization code
// and a working access token. PKCE stops the interceptor redeeming a code they
// stole; redirect_uri matching stops them getting the code delivered to them in
// the first place. Both are classic vulnerability classes and both had no direct
// coverage, so the cases below are chosen to fail if a rule is relaxed, not to
// restate what the code already says.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeRedirectUri, redirectUriAllowed, validCodeVerifier, verifyPkce } from "./pkce";

function challengeFor(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

// RFC 7636 Appendix B's worked example. Pinned rather than computed so that a
// change to the digest or the encoding fails here instead of quietly agreeing
// with a locally computed challenge — every real client derives its challenge
// from the RFC, not from this file.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("validCodeVerifier", () => {
	it("accepts the RFC 7636 worked example", () => {
		expect(validCodeVerifier(RFC_VERIFIER)).toBe(true);
	});

	it("accepts both ends of the 43-128 length range and rejects just outside it", () => {
		// The bounds are the whole point of the check: 42 chars is below the
		// entropy floor the RFC sets, and an unbounded verifier is a free hashing
		// oracle for anyone who can call /token.
		expect(validCodeVerifier("a".repeat(43))).toBe(true);
		expect(validCodeVerifier("a".repeat(128))).toBe(true);
		expect(validCodeVerifier("a".repeat(42))).toBe(false);
		expect(validCodeVerifier("a".repeat(129))).toBe(false);
	});

	it("rejects an empty verifier", () => {
		expect(validCodeVerifier("")).toBe(false);
	});

	it("accepts every character of the unreserved set and nothing else", () => {
		// "-._~" are the unreserved punctuation; anything outside the set either
		// cannot survive a query string intact or is a sign the client is sending
		// something other than a verifier.
		expect(validCodeVerifier(`${"a".repeat(39)}-._~`)).toBe(true);
		for (const bad of ["+", "/", "=", " ", "%", "\n", "é", "\0"]) {
			expect(validCodeVerifier("a".repeat(42) + bad)).toBe(false);
		}
	});

	it("rejects a verifier whose forbidden character sits on a later line", () => {
		// A regex anchored with ^...$ but missing the `m`-less discipline would
		// match the first line only, letting an attacker append anything after a
		// newline. Both anchors have to bind the whole string.
		expect(validCodeVerifier(`${"a".repeat(43)}\nnot-a-verifier`)).toBe(false);
	});
});

describe("verifyPkce", () => {
	it("accepts a correct S256 verifier", () => {
		expect(verifyPkce(RFC_VERIFIER, RFC_CHALLENGE, "S256")).toBe(true);
	});

	it("rejects a wrong verifier of the same length", () => {
		// Same length so the rejection has to come from the digest comparison
		// rather than from the length guard short-circuiting ahead of it.
		const wrong = `${RFC_VERIFIER.slice(0, -1)}X`;
		expect(wrong).toHaveLength(RFC_VERIFIER.length);
		expect(verifyPkce(wrong, RFC_CHALLENGE, "S256")).toBe(false);
	});

	it("rejects method \"plain\" even when the verifier matches the challenge", () => {
		// The one that matters. OAuth 2.1 drops "plain" because the challenge
		// travels in the clear at /authorize, so anyone who can read that request
		// learns the verifier and PKCE protects nothing. A client that asks for
		// plain must be refused, not accommodated — including in the case where
		// the plain comparison would have succeeded.
		expect(verifyPkce(RFC_VERIFIER, RFC_VERIFIER, "plain")).toBe(false);
		expect(verifyPkce(RFC_VERIFIER, RFC_CHALLENGE, "plain")).toBe(false);
	});

	it("rejects any method that is not exactly S256", () => {
		// Downgrade by spelling: an attacker controls code_challenge_method at
		// /authorize, so a case-insensitive or prefix-ish check is a way in.
		for (const method of ["s256", "S256 ", "", "S512", "sha256", "S256;plain", "none"]) {
			expect(verifyPkce(RFC_VERIFIER, RFC_CHALLENGE, method)).toBe(false);
		}
	});

	it("rejects a malformed verifier even when its digest matches the stored challenge", () => {
		// Without the validCodeVerifier guard a client could register a one-byte
		// challenge-side secret and brute force it. The digest here is genuinely
		// correct, so only the bounds check can be what refuses it.
		const short = "abc";
		expect(verifyPkce(short, challengeFor(short), "S256")).toBe(false);
		const long = "a".repeat(129);
		expect(verifyPkce(long, challengeFor(long), "S256")).toBe(false);
		const illegal = `${"a".repeat(40)}+/=`;
		expect(illegal).toHaveLength(43);
		expect(verifyPkce(illegal, challengeFor(illegal), "S256")).toBe(false);
	});

	it("returns false instead of throwing when the challenge length differs", () => {
		// node's timingSafeEqual throws on unequal buffer lengths. A truncated or
		// padded code_challenge is attacker-controlled input, so it has to be a
		// rejected grant rather than a 500 that leaks a stack trace.
		expect(() => verifyPkce(RFC_VERIFIER, "", "S256")).not.toThrow();
		expect(verifyPkce(RFC_VERIFIER, "", "S256")).toBe(false);
		expect(verifyPkce(RFC_VERIFIER, RFC_CHALLENGE.slice(0, 10), "S256")).toBe(false);
		expect(verifyPkce(RFC_VERIFIER, `${RFC_CHALLENGE}=`, "S256")).toBe(false);
		// Base64 with padding is the same digest spelled differently; it is still
		// a different string and must not be accepted as equivalent.
		expect(verifyPkce(RFC_VERIFIER, `${RFC_CHALLENGE}==`, "S256")).toBe(false);
	});

	it("produces an unpadded base64url challenge, not standard base64", () => {
		// "+" and "/" would be mangled in a query string and "=" would need
		// escaping, so a challenge computed with plain base64 must not verify.
		const verifier = "a".repeat(43);
		const standard = createHash("sha256").update(verifier).digest("base64");
		expect(verifyPkce(verifier, standard, "S256")).toBe(false);
		expect(verifyPkce(verifier, challengeFor(verifier), "S256")).toBe(true);
	});
});

describe("redirectUriAllowed", () => {
	it("requires an exact match for a non-loopback uri", () => {
		const registered = ["https://vendor.example.com/oauth/callback"];
		expect(redirectUriAllowed(registered, "https://vendor.example.com/oauth/callback")).toBe(true);
		expect(redirectUriAllowed(registered, "https://vendor.example.com/oauth/callback/")).toBe(false);
		expect(redirectUriAllowed(registered, "http://vendor.example.com/oauth/callback")).toBe(false);
		expect(redirectUriAllowed(registered, "https://vendor.example.com:443/oauth/callback")).toBe(false);
	});

	it("refuses a uri that merely starts with a registered one", () => {
		// The bug this guards against is a `startsWith` or `some(u => uri.includes(u))`
		// match: every one of these keeps the registered value as a prefix and
		// every one of them delivers the code somewhere else.
		const registered = ["https://vendor.example.com/callback"];
		expect(redirectUriAllowed(registered, "https://vendor.example.com/callback.evil.com")).toBe(false);
		expect(redirectUriAllowed(registered, "https://vendor.example.com/callback/../../steal")).toBe(false);
		expect(redirectUriAllowed(registered, "https://vendor.example.com/callback?next=https://evil.example")).toBe(
			false,
		);
		expect(redirectUriAllowed(registered, "https://vendor.example.com/callback#@evil.example")).toBe(false);
	});

	it("refuses a uri that is not registered at all", () => {
		expect(redirectUriAllowed(["https://vendor.example.com/callback"], "https://evil.example/callback")).toBe(false);
		expect(redirectUriAllowed([], "https://vendor.example.com/callback")).toBe(false);
	});

	it("matches a loopback redirect on scheme, host and path with any port", () => {
		// RFC 8252 §7.3: the CLI binds an ephemeral port per login, so the port
		// cannot be known at registration time and must not participate in the
		// comparison.
		const registered = ["http://127.0.0.1/callback"];
		expect(redirectUriAllowed(registered, "http://127.0.0.1:1234/callback")).toBe(true);
		expect(redirectUriAllowed(registered, "http://127.0.0.1:65535/callback")).toBe(true);
		expect(redirectUriAllowed(registered, "http://127.0.0.1/callback")).toBe(true);
	});

	it("still requires the path to match on a loopback redirect", () => {
		// "Any port" is not "anything goes" — a different path on the same
		// loopback host is a different local listener, which on a shared machine
		// is a different program.
		const registered = ["http://127.0.0.1/callback"];
		expect(redirectUriAllowed(registered, "http://127.0.0.1:1234/other")).toBe(false);
		expect(redirectUriAllowed(registered, "http://127.0.0.1:1234/callback/deeper")).toBe(false);
		expect(redirectUriAllowed(registered, "http://127.0.0.1:1234/")).toBe(false);
	});

	it("treats localhost and 127.0.0.1 as the same registered loopback entry", () => {
		// A preview deployment was seen rewriting one spelling to the other before
		// the request reached the app, so both must resolve to the registered
		// 127.0.0.1 form.
		const registered = ["http://127.0.0.1/callback"];
		expect(redirectUriAllowed(registered, "http://localhost:8123/callback")).toBe(true);
		expect(redirectUriAllowed(registered, "http://localhost/callback")).toBe(true);
	});

	it("accepts the ipv6 loopback literal", () => {
		// URL.hostname keeps the brackets for an IPv6 literal, so the registered
		// entry has to carry them too — a client on an IPv6-only loopback would
		// otherwise be unable to log in at all.
		const registered = ["http://[::1]/callback"];
		expect(redirectUriAllowed(registered, "http://[::1]:4111/callback")).toBe(true);
		expect(redirectUriAllowed(registered, "http://[::1]/callback")).toBe(true);
		// ::1 is not 127.0.0.1: they are separate registrations, not aliases.
		expect(redirectUriAllowed(["http://127.0.0.1/callback"], "http://[::1]:4111/callback")).toBe(false);
	});

	it("does not give a non-loopback http uri the any-port treatment", () => {
		// The port relaxation exists because the loopback interface is not
		// reachable from off the machine. Extending it to a routable host would
		// let a code be delivered to any port an attacker can listen on.
		expect(redirectUriAllowed(["http://evil.example/callback"], "http://evil.example:9999/callback")).toBe(false);
		expect(redirectUriAllowed(["http://127.0.0.1.evil.example/callback"], "http://127.0.0.1.evil.example:9999/callback")).toBe(
			false,
		);
		// Nor to a loopback host reached over a non-http scheme.
		expect(redirectUriAllowed(["https://127.0.0.1/callback"], "https://127.0.0.1:9999/callback")).toBe(false);
	});

	it("does not treat a host that merely embeds a loopback spelling as loopback", () => {
		// "localhost.evil.example" and userinfo tricks both parse to a routable
		// host; only URL.hostname decides, and it must be the whole host.
		expect(redirectUriAllowed(["http://127.0.0.1/callback"], "http://localhost.evil.example:1/callback")).toBe(false);
		expect(redirectUriAllowed(["http://127.0.0.1/callback"], "http://127.0.0.1@evil.example/callback")).toBe(false);
		expect(redirectUriAllowed(["http://127.0.0.1/callback"], "http://evil.example/?x=http://127.0.0.1/callback")).toBe(
			false,
		);
	});

	it("returns false instead of throwing on an unparseable redirect_uri", () => {
		// redirect_uri is raw query-string input from an unauthenticated caller,
		// so garbage must be a refusal rather than an exception escaping into the
		// /authorize handler.
		for (const bad of ["", "not a url", "/callback", "://", "http://", "javascript:alert(1)"]) {
			expect(() => redirectUriAllowed(["http://127.0.0.1/callback"], bad)).not.toThrow();
			expect(redirectUriAllowed(["http://127.0.0.1/callback"], bad)).toBe(false);
		}
	});

	it("checks the requested uri against every registered entry, not just the first", () => {
		const registered = ["https://a.example/cb", "https://b.example/cb", "http://127.0.0.1/cb"];
		expect(redirectUriAllowed(registered, "https://b.example/cb")).toBe(true);
		expect(redirectUriAllowed(registered, "http://127.0.0.1:5500/cb")).toBe(true);
	});
});

describe("normalizeRedirectUri", () => {
	it("canonicalises a loopback host so localhost and 127.0.0.1 compare equal", () => {
		// This is the only reason the function exists: core.ts normalises both
		// sides before comparing the /authorize redirect_uri with the /token one,
		// and the two can arrive spelled differently.
		expect(normalizeRedirectUri("http://localhost:8123/callback")).toBe(
			normalizeRedirectUri("http://127.0.0.1:8123/callback"),
		);
		expect(normalizeRedirectUri("http://localhost:8123/callback")).toBe("http://127.0.0.1:8123/callback");
	});

	it("keeps the loopback port, so two different ports do not compare equal", () => {
		// Note this is deliberately stricter than redirectUriAllowed, which
		// ignores the port per RFC 8252. Registration cannot know the port;
		// the token exchange can, because the same client sent it minutes earlier
		// at /authorize. Collapsing the port here would let a code issued to a
		// listener on one port be redeemed by quoting another.
		expect(normalizeRedirectUri("http://127.0.0.1:8123/callback")).not.toBe(
			normalizeRedirectUri("http://127.0.0.1:9124/callback"),
		);
	});

	it("is idempotent, including for a loopback uri with no port", () => {
		// core.ts normalises values that may already have been normalised, so a
		// second pass must not change the result.
		for (const uri of ["http://localhost/callback", "http://localhost:8123/callback", "https://v.example/cb"]) {
			const once = normalizeRedirectUri(uri);
			expect(normalizeRedirectUri(once)).toBe(once);
		}
	});

	it("leaves a non-loopback uri completely untouched", () => {
		// Byte-for-byte: the exact-match comparison downstream depends on nothing
		// here rewriting a trailing slash, a default port, a query string or the
		// case of the path.
		for (const uri of [
			"https://vendor.example.com/oauth/callback",
			"https://vendor.example.com/oauth/callback/",
			"https://vendor.example.com:8443/CallBack?a=1&b=2#frag",
			"http://vendor.example.com/callback",
			"https://VENDOR.example.com/callback",
			"com.vendor.app:/oauth2redirect",
		]) {
			expect(normalizeRedirectUri(uri)).toBe(uri);
		}
	});

	it("returns unparseable input unchanged rather than throwing", () => {
		// Garbage in, same garbage out: it will fail the equality check against
		// the stored value anyway, and an exception here would be a 500 on a
		// request that should be a plain invalid_grant.
		for (const bad of ["", "not a url", "/callback", "://"]) {
			expect(() => normalizeRedirectUri(bad)).not.toThrow();
			expect(normalizeRedirectUri(bad)).toBe(bad);
		}
	});
});
