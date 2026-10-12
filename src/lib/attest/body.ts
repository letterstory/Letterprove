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
import { nextSnapshotAt } from "./cadence";
import { verifyLink } from "./verify-link";
import { withDisclosure } from "./issuer";

const METHOD_PATH = "src/lib/attest/proofs.ts";

/**
 * What the evidence supports, which is not always what the vendor asserts.
 *
 * The asserted tier is a CEILING, never a floor. A customer record can say
 * tier 2; only an observation can earn it. With nothing observed in the
 * window, every fact we hold about that customer came from the vendor —
 * which is tier 0 in the README's trust model, and cannot be `verified` at
 * any tier.
 *
 * The ceiling is tier 3. Tier 4 (a customer counter-signing their own
 * attestation via an emailed link) was retired on 2026-10-12: Letterprove
 * attests from the vendor's DNS proof and the vendor's own Stripe ledger, and
 * does not email the vendor's customers. Old snapshots that carry tier 4 stay
 * in their chains and still verify; nothing new earns it.
 */
export function earned(
	customer: CustomerFixture,
	observed: boolean,
	domainVerified: boolean,
	payment?: PaymentEvidence | null,
): { tier: Tier; verified: boolean } {
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
	 * Deliberately NOT capped by `customer.tier`. The asserted tier is a ceiling on VENDOR-ORIGINATED evidence,
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

	// Capped at 3 so a stored row still asserting the retired tier 4 can never
	// publish it.
	return { tier: Math.min(customer.tier, 3) as Tier, verified: customer.verified };
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
		next_snapshot_at: nextSnapshotAt(snapshot.published_at),
		verify: verifyLink(vendor.slug, customer.slug, snapshot.published_at),
		...withDisclosure(vendor.name, vendor.issuerAffiliation),
		method: methodUrl(METHOD_PATH),
	};
	return { body, snapshot };
}
