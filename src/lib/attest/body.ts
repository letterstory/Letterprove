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
	 * ceiling exists to stop. Capping this would mean a vendor's own
	 * understatement suppressing third-party corroboration, which is backwards.
	 *
	 * WHAT THIS TIER IS AND IS NOT. It used to be described here as impossible
	 * to fabricate without defrauding someone. That was wrong, and cheaply so:
	 * every condition behind it was the vendor's to set, and a $0 recurring
	 * price on a customer record they typed reached `active` in Stripe for
	 * nothing. The bar now is an invoice that settled through a processor for a
	 * non-zero amount, recently, in a live-mode account — see
	 * src/lib/stripe/map.ts. That is money genuinely leaving somebody's account
	 * and a record in the vendor's own books, which is a real cost, but a vendor
	 * determined to pay themselves through their own Stripe account can still
	 * reach it. What tier 3 honestly claims is corroboration by a third party's
	 * ledger, not immunity from a vendor willing to spend money on a lie.
	 *
	 * The positive-amount check is not belt-and-braces. `payment` is an object,
	 * so a bare truthiness test published `contract_monthly: 0` as a signed
	 * fact — a number an agent reads as "pays nothing", asserted as verified.
	 *
	 * It still sits BELOW the observed/domainVerified gates above. Money proves
	 * a commercial relationship; it does not prove the product was used, and
	 * this system only ever claims what it observed.
	 */
	if (payment && payment.monthlyAmount > 0) return { tier: 3, verified: true };

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
	const stored = vendor.id ? await paymentEvidenceFor(vendor.id, customer.domain) : null;
	// One condition, shared by the tier decision and the fields, so the document
	// can never carry a contract figure the tier did not earn or vice versa.
	const payment = stored && stored.monthlyAmount > 0 ? stored : null;
	const { tier, verified } = earned(customer, snapshot.observed, vendor.domainVerified, payment);
	const body = {
		vendor: vendor.slug,
		customer: customer.slug,
		customer_name: customer.name,
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
