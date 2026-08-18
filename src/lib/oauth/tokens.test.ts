// Tokens are stored hashed, never raw. These tests pin the two properties the
// rest of the OAuth server depends on: the hash is a stable, one-way function of
// the token (so a lookup by hash finds exactly the row that issued it), and the
// comparison used to check it does not leak by timing.

import { describe, expect, it } from "vitest";
import {
	generateAccessToken,
	generateAuthorizationCode,
	generateFamilyId,
	generateNonce,
	generateRefreshToken,
	hashToken,
	timingSafeEqualHex,
} from "./tokens";

describe("hashToken", () => {
	it("is deterministic — the same token always finds the same row", () => {
		const token = generateAccessToken();
		expect(hashToken(token)).toBe(hashToken(token));
	});

	it("produces a 64-char hex sha-256 digest", () => {
		expect(hashToken("lp_oat_deadbeef")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("matches the known sha-256 of a fixed input", () => {
		// A pinned vector, not a self-consistency check: if the algorithm or the
		// encoding ever changed, every stored token in the database would stop
		// resolving, so this must fail loudly rather than silently agree with
		// itself.
		expect(hashToken("letterprove")).toBe("2fa5e1d353009e4010e1e1304bc7a9cfd42df41fd8e22eb27bacdf5b6a00a14b");
	});

	it("does not contain the token it hashed", () => {
		const token = generateAccessToken();
		expect(hashToken(token)).not.toContain(token.slice("lp_oat_".length));
	});

	it("gives different digests to different tokens", () => {
		expect(hashToken(generateAccessToken())).not.toBe(hashToken(generateAccessToken()));
	});
});

describe("token generation", () => {
	it("prefixes each kind distinctly so a leaked credential is identifiable", () => {
		expect(generateAccessToken()).toMatch(/^lp_oat_[0-9a-f]{64}$/);
		expect(generateRefreshToken()).toMatch(/^lp_ort_[0-9a-f]{64}$/);
		expect(generateAuthorizationCode()).toMatch(/^lp_oac_[0-9a-f]{64}$/);
	});

	it("never repeats a token", () => {
		const seen = new Set(Array.from({ length: 200 }, () => generateAccessToken()));
		expect(seen.size).toBe(200);
	});

	it("mints uuid families and url-safe nonces", () => {
		expect(generateFamilyId()).toMatch(/^[0-9a-f-]{36}$/);
		// The nonce travels in a query string on the way to the consent page, so
		// it must survive without escaping.
		const nonce = generateNonce();
		expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(encodeURIComponent(nonce)).toBe(nonce);
	});
});

describe("timingSafeEqualHex", () => {
	it("accepts identical digests", () => {
		const digest = hashToken("lp_oat_a");
		expect(timingSafeEqualHex(digest, digest)).toBe(true);
	});

	it("rejects different digests", () => {
		expect(timingSafeEqualHex(hashToken("lp_oat_a"), hashToken("lp_oat_b"))).toBe(false);
	});

	it("returns false instead of throwing on a length mismatch", () => {
		// node's timingSafeEqual throws on unequal lengths; a malformed value
		// arriving from a client must be a rejection, not a 500.
		expect(timingSafeEqualHex(hashToken("lp_oat_a"), "abcd")).toBe(false);
		expect(timingSafeEqualHex("", hashToken("lp_oat_a"))).toBe(false);
	});
});
