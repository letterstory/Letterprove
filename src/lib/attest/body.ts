/**
 * Builds one customer's unsigned attestation body from fixtures + live
 * telemetry. Shared by proofs.ts (the live "current" entry) and
 * rollup/freeze.ts (the durable, persisted entry) so both ever construct a
 * body the same way.
 */

import { methodUrl } from "./method";
import type { CustomerFixture, VendorFixture } from "../fixtures/vendors";
import { currentSnapshot, type CustomerSnapshot } from "@/rollup/snapshots";
import type { AttestationBody, Tier } from "./types";
import { paymentEvidenceFor, type PaymentEvidence } from "./payment-evidence";

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
 *
 * Tier 4 is the one exception to "the vendor's assertion is a ceiling": a
 * customer counter-signing their own attestation (src/app/attest/[vendor]/
 * [customer]/consent) is evidence that doesn't run through the vendor's
 * domain/script pipeline at all — that's the entire point of it being the
 * one tier a vendor can't forge (README § The trust model). So it isn't
 * capped by domainVerified/observed the way tiers 1-3 are; it short-circuits
 * ahead of them.
 *
 * What it is worth depends entirely on WHOSE domain it is bound to. A
 * counter-signature proves a mailbox on `customer.domain` approved the claim,
 * and a vendor who registered that domain themselves holds that mailbox. The
 * README accepts that trade and this function keeps it: it does not try to
 * decide whether a domain is "really" a third party. It is the published body
 * that has to carry `customer_domain`, so a reader can make that judgement
 * instead of taking tier 4 on faith.
 */
export function earned(
	customer: CustomerFixture,
	observed: boolean,
	domainVerified: boolean,
	payment?: PaymentEvidence | null,
): { tier: Tier; verified: boolean } {
	if (customer.countersignedAt) return { tier: 4, verified: true };

	// Same ceiling, one step earlier. An observation is only evidence if we
	// know who the origin it was pinned to belongs to — and `Origin` binds a
	// browser, not curl (see /v1/observe). Until DNS control of the vendor's
	// domain is proven, every observation is the vendor asserting, so it earns
	// exactly what an assertion earns.
	if (!domainVerified) return { tier: 0, verified: false };
	if (!observed) return { tier: 0, verified: false };

	/*
	 * Tier 3 — payment corroborated by Stripe.
	 *
	 * Deliberately NOT capped by `customer.tier`, for the same reason tier 4
	 * isn't. The asserted tier is a ceiling on VENDOR-ORIGINATED evidence,
	 * because a vendor claiming more than they can show is the failure that
	 * ceiling exists to stop. Payment read from the vendor's own Stripe account
	 * did not pass through their hands: they can cancel a subscription, but
	 * they cannot fabricate one without defrauding themselves. Capping it would
	 * mean a vendor's own understatement suppressing third-party corroboration,
	 * which is backwards.
	 *
	 * It still sits BELOW the observed/domainVerified gates above. Money proves
	 * a commercial relationship; it does not prove the product was used, and
	 * this system only ever claims what it observed.
	 */
	if (payment) return { tier: 3, verified: true };

	return { tier: customer.tier, verified: customer.verified };
}

/**
 * Returns the snapshot alongside the body, not just the body.
 *
 * The snapshot carries `readOk`/`observed`, which are evidence *about* the
 * claim and never part of it. They can't be recovered from the finished body —
 * a tier-0 body looks identical whether it came from a clean read of an empty
 * table or from a query that failed — and rollup/freeze.ts has to tell those
 * apart before writing an immutable row.
 */
export async function attestationBody(
	vendor: VendorFixture,
	customer: CustomerFixture
): Promise<{ body: Omit<AttestationBody, "prev_hash">; snapshot: CustomerSnapshot }> {
	const snapshot = await currentSnapshot(vendor.slug, customer.domain);
	const payment = vendor.id ? await paymentEvidenceFor(vendor.id, customer.domain) : null;
	const { tier, verified } = earned(customer, snapshot.observed, vendor.domainVerified, payment);
	const body = {
		vendor: vendor.slug,
		customer: customer.slug,
		customer_name: customer.name,
		// The subject of the claim, not decoration. Name and domain are both
		// vendor-chosen and unrelated to each other, so a document carrying only
		// the name gives a reader no way to tell a real "Acme Corp" from a
		// lookalike registered on a domain the vendor owns. See customer_domain
		// in ./types.ts.
		customer_domain: customer.domain,
		verified,
		tier,
		since: customer.since,
		features: [...customer.features].sort(),
		sessions_30d: snapshot.sessions_30d,
		// Published only when Stripe corroborated it. Absent rather than zero
		// for everyone else: a zero would read as "pays nothing", which is a
		// claim, where absence is the truth — we have no payment evidence.
		...(payment
			? {
					contract_currency: payment.currency,
					contract_monthly: payment.monthlyAmount,
					contract_since: payment.since,
				}
			: {}),
		seats_active: snapshot.seats_active,
		observed_through: snapshot.observed_through,
		published_at: snapshot.published_at,
		ttl: TTL_SECONDS,
		method: methodUrl(METHOD_PATH),
	};
	return { body, snapshot };
}
