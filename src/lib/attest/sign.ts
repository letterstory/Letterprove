import { countersign } from "./countersign";
import type { FraudFeatures } from "./fraud-features";

/**
 * Sign one attestation body.
 *
 * `key_id` comes back from the signer rather than being supplied: the id has to
 * name the key that actually produced the signature, and only the signer knows
 * which that was. A caller-stamped id is a lie waiting to happen at the first
 * rotation.
 */
export async function signAttestation<T extends object>(
	body: T,
	features?: FraudFeatures
): Promise<T & { key_id: string; signature: string }> {
	// Re-signing an already-signed document is an easy mistake — spread a
	// SignedAttestation, change a number, sign again — and it produces a
	// document that can NEVER verify, because the stale `signature` and
	// `key_id` end up inside the newly signed bytes. The types forbid it; this
	// catches the spread that erases the types.
	for (const field of ["signature", "key_id"]) {
		if (field in body) {
			throw new Error(`cannot sign a body that already carries "${field}" — strip it first`);
		}
	}

	const { signature, key_id } = await countersign(body, features);
	return { ...body, key_id, signature };
}
