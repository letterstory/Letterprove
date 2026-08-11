/**
 * Verification, as an agent would do it.
 *
 * Kept deliberately close to what an outside party can perform with nothing but
 * the published JSON and the JWKS endpoint. If something here needs private
 * knowledge, the proof is not actually verifiable and the design is wrong.
 */

import { createHash, createPublicKey, verify as edVerify, type JsonWebKey } from "node:crypto";
import { canonicalBytes, canonicalize } from "./canonical";
import type { Jwks, SignedAttestation, VerifyResult } from "./types";

/** The prev_hash of a customer's first-ever snapshot. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Hash of a signed snapshot, hex — the value its successor carries as
 * `prev_hash`. The signature is inside the hash on purpose: chaining over the
 * body alone would let a snapshot be re-signed with different key material
 * without breaking the chain.
 */
export function snapshotHash(signed: SignedAttestation): string {
	return createHash("sha256").update(canonicalize(signed), "utf8").digest("hex");
}

/** Verify one attestation's signature against a JWKS. */
export function verifyAttestation(signed: SignedAttestation, jwks: Jwks): VerifyResult {
	const { signature, ...body } = signed;
	if (!signature) return { ok: false, reason: "no signature" };

	const jwk = jwks.keys.find((k) => k.kid === signed.key_id);
	if (!jwk) {
		return {
			ok: false,
			reason: `no published key with id "${signed.key_id}" — retired keys must stay in the JWKS`,
		};
	}

	let ok: boolean;
	try {
		// Node types a JWK as an open string-indexed record; PublicJwk is the
		// closed shape we actually publish. Structurally identical, so widen
		// rather than loosen the published type.
		const publicKey = createPublicKey({ key: { ...jwk } as JsonWebKey, format: "jwk" });
		// `body` still carries key_id — it is inside the signature, so a swapped
		// id fails here rather than silently selecting a different key.
		ok = edVerify(null, canonicalBytes(body), publicKey, Buffer.from(signature, "base64url"));
	} catch (e) {
		return { ok: false, reason: `key unusable: ${(e as Error).message}` };
	}

	return ok ? { ok: true } : { ok: false, reason: "signature does not match the document" };
}

/**
 * Verify a customer's full history: every signature valid, and every snapshot
 * pointing at its predecessor.
 *
 * @param chain oldest first
 */
export function verifyChain(chain: SignedAttestation[], jwks: Jwks): VerifyResult {
	if (chain.length === 0) return { ok: false, reason: "empty chain" };

	let expectedPrev = GENESIS_HASH;
	for (const [i, snapshot] of chain.entries()) {
		const sig = verifyAttestation(snapshot, jwks);
		if (!sig.ok) return { ok: false, reason: `snapshot ${i} (${snapshot.observed_through}): ${sig.reason}` };

		if (snapshot.prev_hash !== expectedPrev) {
			return {
				ok: false,
				reason: `snapshot ${i} (${snapshot.observed_through}): prev_hash ${snapshot.prev_hash.slice(0, 12)}… does not match predecessor ${expectedPrev.slice(0, 12)}…`,
			};
		}
		expectedPrev = snapshotHash(snapshot);
	}

	return { ok: true };
}
