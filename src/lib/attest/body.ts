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
 * Fields of a customer attestation that come from the vendor's customer
 * record, not from anything Letterprove observed or read from a third party.
 * The name and the start date are typed by the vendor; `features` are strings
 * the vendor put on the record (no feature event is observed today). Naming
 * permission is likewise the vendor's statement. Published in every body as
 * `vendor_stated` (decision 29).
 */
export const VENDOR_STATED = ["customer_name", "since", "features"] as const;

/**
 * What the evidence supports — and nothing else.
 *
 * The tier is derived from evidence alone. There is no vendor-asserted tier
 * any more: `vendor_customers.tier` is a legacy column this function does not
 * read (decision 29). A vendor can say who its customers are; it cannot say
 * how strong the evidence is.
 *
 *   0  nothing observed, or the vendor's domain is not proven by DNS
 *   1  sign-ins observed by the script on the vendor's DNS-proven domain
 *   3  tier 1, plus a settled invoice for this domain in the vendor's own
 *      live Stripe account
 *
 * Tier 2 (infrastructure-bound) is NOT ISSUED. It describes observations bound
 * to network facts the vendor cannot choose (ASN distribution), and that
 * binding is not built — fraud-features.ts still sends `asn_distribution:
 * null`. Until it is, claiming tier 2 would describe evidence we do not hold.
 *
 * Tier 4 (a customer counter-signing via an emailed link) was retired on
 * 2026-10-12. Old snapshots that carry 2 or 4 stay in their chains and still
 * verify; nothing new earns either.
 *
 * `verified` means "corroborated by a third party", which today is only
 * tier 3. A tier-1 observation is evidence, but evidence the vendor could
 * fabricate with effort (a non-browser client can send any Origin), so it is
 * published as observed, not verified.
 *
 * `customer` is accepted so every call site keeps one shape; nothing on it
 * affects the result.
 */
export function earned(
	_customer: CustomerFixture,
	observed: boolean,
	domainVerified: boolean,
	payment?: PaymentEvidence | null,
): { tier: Tier; verified: boolean } {
	// An observation is only evidence if we
	// know who the origin it was pinned to belongs to — and `Origin` binds a
	// browser, not curl (see /v1/observe). Until DNS control of the vendor's
	// domain is proven, every observation is the vendor asserting, so it earns
	// exactly what an assertion earns.
	if (!domainVerified) return { tier: 0, verified: false };
	if (!observed) return { tier: 0, verified: false };

	/*
	 * Tier 3 — payment corroborated by Stripe.
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

	return { tier: 1, verified: false };
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
		// Which fields in this document are the vendor's word rather than our
		// evidence. Signed, so an agent never has to infer it — and so no page
		// or summary can quietly present one of these as proven.
		vendor_stated: [...VENDOR_STATED],
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
