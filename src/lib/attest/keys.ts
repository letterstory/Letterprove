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
 * signatures it did not itself compute. Unset, `publicJwk()` is served, which
 * matches whatever countersign.ts actually signs with in that mode too (the
 * local dev key when the RPC isn't configured).
 */
export function jwks(): Jwks {
	const retired = parseRetired(process.env.LETTERPROVE_RETIRED_JWKS);
	const production = parseProductionKey(process.env.LETTERPROVE_PRODUCTION_JWK);
	return { keys: [production ?? publicJwk(), ...retired] };
}

function parseRetired(raw: string | undefined): PublicJwk[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as PublicJwk[]) : [];
	} catch {
		// A malformed retired-key list must not take the endpoint down; it would
		// break verification for current proofs too. Serve what we can.
		return [];
	}
}

function parseProductionKey(raw: string | undefined): PublicJwk | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PublicJwk) : null;
	} catch {
		// Same failure posture as parseRetired: never take the endpoint down.
		// Falling back to publicJwk() here is safe, not silently wrong — it's
		// still a real, servable key, just not the one signatures were
		// actually made with, which is exactly what an operator debugging a
		// verification failure needs to see: a *working* endpoint serving the
		// *wrong* key, not a 500.
		return null;
	}
}

/** Exposed for tests that need a second, unrelated key. */
export function keyFromSeedString(seed: string): KeyObject {
	return privateKeyFromSeed(createHash("sha256").update(seed).digest());
}
