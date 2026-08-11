/**
 * The signing seam.
 *
 * Letterprove computes a snapshot; Letterstory scores it for fraud and
 * countersigns; Letterprove publishes the result. The authority to say "this is
 * true" is the one capability that does not live in this service — if it did,
 * the fraud check would be a report nobody is obliged to obey, and a single
 * compromise here would mint arbitrary valid proofs.
 *
 * The seam is a runtime call, not a build dependency, which is what lets this
 * repo ship a new signal or rollup without Letterstory moving.
 *
 * Today it signs locally with the development key so the publishing half can be
 * built and tested before Letterstory has an endpoint. The function signature is
 * the one the RPC will have, so wiring it up is a change to this file alone.
 */

import { sign as edSign } from "node:crypto";
import { canonicalBytes } from "./canonical";
import { signingKey } from "./keys";
import type { AttestationBody } from "./types";

export interface Countersignature {
	signature: string;
	key_id: string;
}

/**
 * Ask the signer to attest to a body.
 *
 * It takes the body rather than finished bytes because `key_id` is inside the
 * signature and only the signer knows which key it is about to use. Canonical
 * form is therefore computed here, after the id is stamped — a caller that
 * pre-serialised would be signing a document that differs from the one
 * published, and every verification would fail.
 */
export async function countersign(body: AttestationBody): Promise<Countersignature> {
	// TODO(letterstory): POST the body plus its fraud-feature summary and return
	// the signature Letterstory issues. A refusal is not an error to swallow —
	// an unsigned snapshot must never be published, so let it throw.
	const { privateKey, keyId } = signingKey();
	const bytes = canonicalBytes({ ...body, key_id: keyId });
	return { signature: edSign(null, bytes, privateKey).toString("base64url"), key_id: keyId };
}
