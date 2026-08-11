import { signAttestation } from "./sign";
import { GENESIS_HASH, snapshotHash } from "./verify";
import type { AttestationBody, SignedAttestation } from "./types";

/**
 * Sign a customer's snapshots into a chain, oldest first.
 *
 * Each snapshot's `prev_hash` is computed here rather than supplied, so a
 * caller cannot accidentally publish a history with a hole in it. Any
 * `prev_hash` already on the body is overwritten.
 */
export async function buildChain(
	bodies: Omit<AttestationBody, "prev_hash">[]
): Promise<SignedAttestation[]> {
	const chain: SignedAttestation[] = [];
	let prev = GENESIS_HASH;

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
