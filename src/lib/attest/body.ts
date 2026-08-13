/**
 * Builds one customer's unsigned attestation body from fixtures + live
 * telemetry. Shared by proofs.ts (the live "current" entry) and
 * rollup/freeze.ts (the durable, persisted entry) so both ever construct a
 * body the same way.
 */

import { methodUrl } from "./method";
import type { CustomerFixture, VendorFixture } from "../fixtures/vendors";
import { currentSnapshot } from "@/rollup/snapshots";
import type { AttestationBody, Tier } from "./types";

const METHOD_PATH = "src/lib/attest/proofs.ts";

/** How long an agent may cache a proof. One hour matches the publish cadence. */
export const TTL_SECONDS = 3600;

/**
 * What the evidence supports, which is not always what the vendor asserts.
 *
 * The asserted tier is a CEILING, never a floor. A customer record can say
 * tier 2; only an observation can earn it. With nothing observed in the
 * window, every fact we hold about that customer came from the vendor —
 * which is tier 0 in the README's trust model, and cannot be `verified` at
 * any tier.
 */
export function earned(customer: CustomerFixture, observed: boolean): { tier: Tier; verified: boolean } {
	if (!observed) return { tier: 0, verified: false };
	return { tier: customer.tier, verified: customer.verified };
}

export async function attestationBody(
	vendor: VendorFixture,
	customer: CustomerFixture
): Promise<Omit<AttestationBody, "prev_hash">> {
	const snapshot = await currentSnapshot(vendor.slug, customer.domain);
	const { tier, verified } = earned(customer, snapshot.observed);
	return {
		vendor: vendor.slug,
		customer: customer.slug,
		customer_name: customer.name,
		verified,
		tier,
		since: customer.since,
		features: [...customer.features].sort(),
		sessions_30d: snapshot.sessions_30d,
		seats_active: snapshot.seats_active,
		observed_through: snapshot.observed_through,
		published_at: snapshot.published_at,
		ttl: TTL_SECONDS,
		method: methodUrl(METHOD_PATH),
	};
}
