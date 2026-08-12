import { signAttestation } from "./sign";
import { GENESIS_HASH, snapshotHash } from "./verify";
import type { AttestationBody, SignedAttestation } from "./types";

/**
 * Sign a customer's snapshots into a chain.
 *
 * Each snapshot's `prev_hash` is computed here rather than supplied, so a
 * caller cannot accidentally publish a history with a hole in it. Any
 * `prev_hash` already on the body is overwritten.
 *
 * `startingPrevHash` lets a caller extend an already-persisted chain (pass
 * the hash of its last entry) instead of always starting a fresh one from
 * genesis — see rollup/freeze.ts and attest/proofs.ts.
 */
export async function buildChain(
	bodies: Omit<AttestationBody, "prev_hash">[],
	startingPrevHash: string = GENESIS_HASH
): Promise<SignedAttestation[]> {
	const chain: SignedAttestation[] = [];
	let prev = startingPrevHash;

	for (const body of bodies) {
		const signed = await signAttestation({ ...body, prev_hash: prev });
		chain.push(signed);
		prev = snapshotHash(signed);
	}

	return chain;
}

/** The newest snapshot — what `/attest/{vendor}/{customer}.json` serves. */
export function head(chain: SignedAttestation[]): SignedAttestation {
	const last = chain.at(-1);
	if (!last) throw new Error("cannot take the head of an empty chain");
	return last;
}
