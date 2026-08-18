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
 * With `LETTERSTORY_COUNTERSIGN_URL`/`LETTERSTORY_COUNTERSIGN_SECRET`
 * configured, this calls the real RPC (lb's `POST
 * /api/letterprove/countersign`). Without them it signs locally with the
 * development key, so the publishing half can still be built and tested
 * standalone.
 */

import { sign as edSign } from "node:crypto";
import { canonicalBytes } from "./canonical";
import { fraudFeatures } from "./fraud-features";
import { countersignConfigured, signingKey } from "./keys";
import { findCustomer, findVendor } from "../fixtures/vendors";
import type { FraudFeatures } from "./fraud-features";

export interface Countersignature {
	signature: string;
	key_id: string;
}

const RPC_TIMEOUT_MS = 20_000;

/**
 * Ask the signer to attest to a body.
 *
 * It takes the body rather than finished bytes because `key_id` is inside the
 * signature and only the signer knows which key it is about to use. Canonical
 * form is therefore computed here, after the id is stamped — a caller that
 * pre-serialised would be signing a document that differs from the one
 * published, and every verification would fail.
 */
/**
 * @param features pre-computed fraud features. Supplied by callers whose body
 *   is not customer-shaped — the vendor-level aggregate, which has no
 *   `customer` to look up. Omitted, they are derived from the body's
 *   vendor/customer as before.
 */
export async function countersign(
	body: object,
	features?: FraudFeatures
): Promise<Countersignature> {
	// keys.ts owns this predicate so `signingMode()` and this branch can never
	// disagree about which signer is live — the banner saying one thing while
	// the signature says another is exactly the failure this consolidates.
	if (countersignConfigured()) {
		return countersignRemote(
			process.env.LETTERSTORY_COUNTERSIGN_URL!,
			process.env.LETTERSTORY_COUNTERSIGN_SECRET!,
			body,
			features
		);
	}

	// DEVELOPMENT: no RPC configured. See keys.ts — this signs with a key
	// derived from a published, non-secret seed, so nothing produced this way
	// is evidence.
	const { privateKey, keyId } = signingKey();
	const bytes = canonicalBytes({ ...body, key_id: keyId });
	return { signature: edSign(null, bytes, privateKey).toString("base64url"), key_id: keyId };
}

/**
 * A refusal (403, fraud check failed) or any other non-2xx response is not an
 * error to swallow — an unsigned snapshot must never be published, so every
 * failure path here throws rather than falling back to local signing.
 */
async function countersignRemote(
	url: string,
	secret: string,
	body: object,
	supplied?: FraudFeatures
): Promise<Countersignature> {
	// Only customer-shaped bodies need the lookup. The vendor-level aggregate
	// makes a claim about every observed company at once, so it has no
	// `customer` to resolve and supplies its own vendor-scoped features.
	let features = supplied;
	if (!features) {
		const shaped = body as { vendor?: string; customer?: string };
		const vendor = shaped.vendor ? await findVendor(shaped.vendor) : undefined;
		const customer = vendor && shaped.customer ? findCustomer(vendor, shaped.customer) : undefined;
		if (!vendor || !customer) {
			throw new Error(
				`countersign: unknown vendor/customer "${shaped.vendor}/${shaped.customer}" — cannot resolve domain for fraud-feature extraction`
			);
		}
		features = await fraudFeatures(vendor.slug, customer.slug, customer.domain);
	}

	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
		body: JSON.stringify({ body, fraud_features: features }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});

	if (res.status === 403) {
		const detail = await safeJson(res);
		throw new Error(`countersign refused: ${typeof detail?.reason === "string" ? detail.reason : "no reason given"}`);
	}
	if (!res.ok) {
		const detail = await safeJson(res);
		const message = typeof detail?.error === "string" ? detail.error : res.statusText;
		throw new Error(`countersign RPC failed: ${res.status} ${message}`);
	}

	const result = await safeJson(res);
	if (typeof result?.signature !== "string" || typeof result?.key_id !== "string") {
		throw new Error("countersign RPC returned a malformed response");
	}
	return { signature: result.signature, key_id: result.key_id };
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
	try {
		return (await res.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}
