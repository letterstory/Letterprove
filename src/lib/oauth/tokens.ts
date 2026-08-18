import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

// Prefixes make a leaked credential grep-able and let logs tell token kinds
// apart at a glance. Same `lp_` family as the vendors' publishable
// `lp_live_…` keys, with a distinct middle segment so the two are never
// confused: `lp_live_` ships in a customer's HTML, `lp_oat_`/`lp_ort_` never
// leave the operator's machine.
const ACCESS_TOKEN_PREFIX = "lp_oat_";
const REFRESH_TOKEN_PREFIX = "lp_ort_";
const AUTH_CODE_PREFIX = "lp_oac_";
const RANDOM_BYTES = 32;

function generateToken(prefix: string): string {
	return `${prefix}${randomBytes(RANDOM_BYTES).toString("hex")}`;
}

export function generateAccessToken(): string {
	return generateToken(ACCESS_TOKEN_PREFIX);
}

export function generateRefreshToken(): string {
	return generateToken(REFRESH_TOKEN_PREFIX);
}

export function generateAuthorizationCode(): string {
	return generateToken(AUTH_CODE_PREFIX);
}

export function generateFamilyId(): string {
	return randomUUID();
}

export function generateNonce(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Tokens and codes are stored hashed. A database read alone should never be
 * enough to impersonate a CLI session — the same reasoning that keeps raw
 * signing material out of this repo (see src/lib/attest/keys.ts).
 */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "hex");
	const bufB = Buffer.from(b, "hex");
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}
