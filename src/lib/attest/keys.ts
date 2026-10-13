/**
 * Signing key material.
 *
 * PRODUCTION: the private key does not live in this repo and is not held by
 * this service. Letterstory countersigns after fraud scoring — see
 * countersign.ts and the "signing seam" section of the README. This module
 * exists so the publishing half can be developed and tested end to end before
 * that seam is wired to anything.
 *
 * DEVELOPMENT: with no key configured we derive one from a fixed, published
 * seed. It is deterministic (so the chain and the tests are stable across
 * restarts) and it is deliberately not a secret — its key id says so out loud,
 * and anything it signs is worthless. A committed PEM would have done the same
 * job while looking exactly like a leaked credential to every scanner that saw
 * it; a seed that spells out what it is cannot be mistaken for one.
 */

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import type { Jwks, PublicJwk } from "./types";

/** Not a secret. Anything signed with the key derived from it is not evidence. */
const DEV_SEED = "letterprove-development-key-do-not-trust";

/** PKCS#8 preamble for a raw Ed25519 private key, per RFC 8410. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function privateKeyFromSeed(seed: Buffer): KeyObject {
	if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
	return createPrivateKey({
		key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
}

let cached: { privateKey: KeyObject; keyId: string; isDev: boolean } | null = null;

/**
 * The active signing key.
 *
 * `LETTERPROVE_SIGNING_KEY` is a base64 32-byte Ed25519 seed. Absent it, the
 * development key is used and every caller can tell from `isDev`.
 */
export function signingKey(): { privateKey: KeyObject; keyId: string; isDev: boolean } {
	if (cached) return cached;

	const configured = process.env.LETTERPROVE_SIGNING_KEY;
	const isDev = !configured;
	const seed = configured
		? Buffer.from(configured, "base64")
		: createHash("sha256").update(DEV_SEED).digest();

	const privateKey = privateKeyFromSeed(seed);
	const keyId = process.env.LETTERPROVE_KEY_ID ?? defaultKeyId(privateKey, isDev);

	cached = { privateKey, keyId, isDev };
	return cached;
}

/**
 * A key id derived from the key itself, so it cannot drift out of sync with the
 * material it names. Dev keys are prefixed to make an accidental production
 * proof signed by one obvious at a glance.
 */
function defaultKeyId(privateKey: KeyObject, isDev: boolean): string {
	const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
	const thumb = createHash("sha256").update(jwk.x).digest("hex").slice(0, 10);
	return `${isDev ? "dev-insecure" : "lp"}-${thumb}`;
}

/**
 * What is actually producing signatures right now.
 *
 * `signingKey().isDev` answers a narrower question — "is the LOCAL key a dev
 * key" — and since the countersign RPC landed, that is no longer the same
 * question as "are the attestations we publish real". This service never holds
 * the production private key (see countersign.ts / the signing seam), so
 * `LETTERPROVE_SIGNING_KEY` is *correctly* unset in production forever, and
 * `isDev` is true there permanently. Anything user-facing that means "this is a
 * demonstration" must ask this instead, or production tells every agent to
 * discount proofs that are in fact real.
 *
 * - `countersigned` — Letterstory signs, with a key this service cannot reach.
 * - `local-key`     — a real key is configured here (LETTERPROVE_SIGNING_KEY).
 * - `development`   — the published, non-secret dev seed. Not evidence.
 */
export type SigningMode = "countersigned" | "local-key" | "development";

/** Single source of truth for whether the RPC is wired; countersign.ts branches on it too. */
export function countersignConfigured(): boolean {
	return Boolean(process.env.LETTERSTORY_COUNTERSIGN_URL && process.env.LETTERSTORY_COUNTERSIGN_SECRET);
}

export function signingMode(): SigningMode {
	if (countersignConfigured()) return "countersigned";
	return signingKey().isDev ? "development" : "local-key";
}

/**
 * Is what we publish a demonstration rather than evidence?
 *
 * The one question the banner, the discovery warning and the freeze guard all
 * actually care about.
 */
export function isDemonstration(): boolean {
	return signingMode() === "development";
}

/** The public half of the active key, ready to serve. */
export function publicJwk(): PublicJwk {
	const { privateKey, keyId } = signingKey();
	const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { kty: string; crv: string; x: string };
	return { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: keyId, alg: "EdDSA", use: "sig" };
}

/**
 * Every key whose signatures should still verify.
 *
 * Rotation is additive: mint a new key, sign with it, and keep the retired
 * public keys here forever. A proof issued in 2026 must still verify in 2031 —
 * dropping a retired key silently invalidates history that we have already told
 * the world is immutable.
 *
 * With `LETTERPROVE_PRODUCTION_JWK` configured, it — not the locally-derived
 * `publicJwk()` — is served as the active key. This service never holds the
 * real private key (see countersign.ts / the "signing seam"); the RPC signer
 * publishes its public half here so this service can still serve JWKS for
 * signatures it did not itself compute.
 *
 * FAILS CLOSED in countersigned mode. There the only honest active key is the
 * one Letterstory signs with; if it is missing or malformed, the only key this
 * service could fall back to is the development key, whose seed is in this
 * file. Serving it would let anyone mint documents that verify — so instead
 * this throws, the endpoint answers 503, and discovery says why. An outage is
 * recoverable; a published key anyone can sign with is not.
 */
export function jwks(): Jwks {
	const result = jwksResult();
	if (!result.ok) throw new KeysUnavailableError(result.error);
	return result.jwks;
}

export class KeysUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KeysUnavailableError";
	}
}

export type JwksResult = { ok: true; jwks: Jwks } | { ok: false; error: string };

export function jwksResult(): JwksResult {
	const retired = parseRetired(process.env.LETTERPROVE_RETIRED_JWKS);
	const production = parseProductionKey(process.env.LETTERPROVE_PRODUCTION_JWK);
	if (signingMode() === "countersigned") {
		const problem = keyProblem();
		if (problem || !production) return { ok: false, error: problem ?? "production signing key unavailable" };
		return { ok: true, jwks: { keys: [production, ...retired] } };
	}
	// Development and local-key modes sign with the local key, so the local
	// key is the honest answer when no valid production key is configured.
	return { ok: true, jwks: { keys: [production ?? publicJwk(), ...retired] } };
}

/**
 * Why the published key set cannot be trusted right now, or null. Only
 * countersigned mode can be misconfigured this way: it is the one mode whose
 * active key comes from configuration rather than from the key that signs.
 */
export function keyProblem(): string | null {
	if (signingMode() !== "countersigned") return null;
	const raw = process.env.LETTERPROVE_PRODUCTION_JWK;
	if (!raw) return "LETTERPROVE_PRODUCTION_JWK is unset, so the key Letterstory signs with cannot be published.";
	const parsed = parseProductionKey(raw);
	if (!parsed) return "LETTERPROVE_PRODUCTION_JWK is not a valid Ed25519 public key.";
	if (parsed.x === publicJwk().x) return "LETTERPROVE_PRODUCTION_JWK is the published development key.";
	return null;
}

function parseRetired(raw: string | undefined): PublicJwk[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as unknown[]).filter(isPublicJwk) : [];
	} catch {
		// A malformed retired-key list must not take the endpoint down; it would
		// break verification for current proofs too. Serve what we can.
		return [];
	}
}

function parseProductionKey(raw: string | undefined): PublicJwk | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return isPublicJwk(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** An Ed25519 public JWK: 32 bytes of `x`, base64url, and a key id. */
function isPublicJwk(value: unknown): value is PublicJwk {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const k = value as Record<string, unknown>;
	return (
		k.kty === "OKP" &&
		k.crv === "Ed25519" &&
		typeof k.x === "string" &&
		/^[A-Za-z0-9_-]{43}$/.test(k.x) &&
		typeof k.kid === "string" &&
		k.kid.length > 0
	);
}

/** Exposed for tests that need a second, unrelated key. */
export function keyFromSeedString(seed: string): KeyObject {
	return privateKeyFromSeed(createHash("sha256").update(seed).digest());
}
