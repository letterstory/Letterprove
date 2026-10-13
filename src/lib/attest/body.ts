/**
 * The evidence rule for one observed company domain.
 *
 * Until 2026-10-13 this module also built the per-customer attestation body.
 * Those documents were retired (README decision 30): Letterprove publishes one
 * vendor attestation and names no customer. What remains is the rule itself,
 * which the vendor-private tier report applies per domain and which the vendor
 * attestation's `paying_companies` counts.
 */

import type { Tier } from "./types";
import type { PaymentEvidence } from "./payment-evidence";

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
 * Applied per observed company domain. Since 2026-10-13 nothing per-customer
 * is published (decision 30): the vendor attestation counts the domains this
 * function puts at tier 3 as `paying_companies`, and the vendor-private tier
 * report shows the vendor which of its observed domains those are.
 *
 * `verified` means "corroborated by a third party", which today is only
 * tier 3. A tier-1 observation is evidence, but evidence the vendor could
 * fabricate with effort (a non-browser client can send any Origin), so it is
 * published as observed, not verified.
 *
 */
export function earned(
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
