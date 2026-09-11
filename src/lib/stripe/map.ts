/**
 * Turn a vendor's Stripe subscriptions into per-domain payment evidence.
 *
 * This is the substantive half of tier 3, and it is deliberately independent
 * of how we authenticate to Stripe. Whether the credential is a restricted API
 * key the vendor pasted in or an OAuth token from a Stripe App, the shape of
 * the answer is the same — so the auth decision cannot block this work, and
 * changing it later doesn't touch a line of this file.
 *
 * Pure: takes already-fetched Stripe objects and returns a mapping. No network,
 * no database, and the only clock reading is one the caller passes in. It can
 * be tested exhaustively without a Stripe account, which matters because the
 * join below is where this feature is most likely to be quietly wrong.
 *
 * WHY THIS IS THE HARD PART. Letterprove's join key is the email domain, and
 * Stripe's is a customer record. `billing@acme.com` lines up with observed
 * traffic from `acme.com` and everything is easy. Real billing is not that
 * tidy: invoices route through parent companies, procurement desks, resellers,
 * and personal mailboxes. Every one of those produces payment evidence we
 * cannot honestly attach to an observed domain — which is precisely the thing
 * tier 3 exists to prove. So unmatched payments are surfaced, never dropped
 * silently and never guessed at: a wrong attribution here would publish a
 * signed claim that a company pays for something it does not.
 *
 * WHY A SUBSCRIPTION IS NOT ENOUGH. `status === "active"` means a subscription
 * exists, not that anyone paid for it. A $0 recurring price reaches `active`
 * with no payment method attached, and so does a 100%-off coupon, so for as
 * long as this file scored intent it published a signed "verified" tier-3
 * claim that cost the vendor nothing to manufacture in their own account. Two
 * rules fix that, and both are below: a recurring amount has to be real money,
 * and an invoice has to have actually settled through a processor. Tenure comes
 * from that settled invoice too, because `start_date` is a field the account
 * owner can backdate to any year they choose.
 */

import { classifyDomain } from "@/lib/identity/domains";
import type { PaidInvoiceIndex } from "./fetch";

/** The subset of a Stripe subscription this mapping needs. */
export interface StripeSubscriptionLike {
	id: string;
	status: string;
	/** Unix seconds, as Stripe sends them. */
	start_date: number;
	currency: string;
	/** Recurring amount in the currency's minor unit, per interval. */
	amount: number | null;
	interval: "day" | "week" | "month" | "year" | null;
	/** The billing email on the attached customer, if any. */
	customerEmail: string | null;
}

export interface DomainPayment {
	domain: string;
	/** Earliest SETTLED invoice across this domain's subscriptions, ISO. */
	since: string;
	currency: string;
	/** Total recurring amount per month, in the currency's minor unit. Always positive. */
	monthlyAmount: number;
	subscriptionCount: number;
}

export type UnmatchedReason =
	/** No email on the customer at all — nothing to join on. */
	| "no_email"
	/** A person's mailbox, or otherwise not a company identity. */
	| "not_a_company"
	/** A company domain, but one this vendor has never been observed serving. */
	| "no_observed_traffic"
	/** Mixed currencies for one domain — see below. */
	| "currency_conflict"
	/** No readable recurring price or interval, so there is no figure to publish. */
	| "no_recurring_amount"
	/** The recurring price is zero, or rounds to nothing per month. */
	| "zero_amount"
	/** Nothing has ever settled against this subscription. */
	| "no_settled_invoice"
	/** An invoice is marked paid with no processor record behind it. */
	| "paid_out_of_band"
	/** Money settled once, but not recently enough for the billing interval. */
	| "payment_lapsed";

export interface UnmatchedPayment {
	subscriptionId: string;
	reason: UnmatchedReason;
	/** The domain we derived, when we got that far. Null when there was none. */
	domain: string | null;
}

export interface PaymentMapping {
	matched: DomainPayment[];
	/** Never silently discarded — a vendor has to be able to see and fix these. */
	unmatched: UnmatchedPayment[];
}

/**
 * Subscription statuses that represent a live billing relationship. `trialing`
 * is deliberately excluded: a trial is not a paying customer. `past_due` is
 * also excluded — the relationship exists but the payment has not landed.
 *
 * Necessary and not sufficient. Every status Stripe has is set by the account
 * owner's configuration, so this gate is passed by a subscription nobody ever
 * paid for; the settled-invoice gate below is the one that costs money.
 */
const PAYING_STATUSES = new Set(["active"]);

/** Per-month equivalents, so mixed billing intervals can be summed. */
const MONTHS_PER_INTERVAL: Record<string, number> = {
	day: 1 / 30,
	week: 1 / 4.345,
	month: 1,
	year: 12,
};

/**
 * How long after a settled invoice the relationship still counts as paid, per
 * billing interval. One interval plus a grace period that covers Stripe's own
 * dunning retries and a late invoice being chased.
 *
 * The failure this prevents is a subscription that stays `active` for years
 * while nothing is collected — `send_invoice` collection with a long due date
 * does exactly that — quietly publishing "pays us" in the present tense on the
 * strength of one payment in 2023.
 */
const SETTLED_WITHIN_DAYS: Record<string, number> = {
	day: 8,
	week: 21,
	month: 66,
	year: 400,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function domainOfEmail(email: string): string | null {
	const at = email.lastIndexOf("@");
	if (at <= 0 || at === email.length - 1) return null;
	return email.slice(at + 1).trim().toLowerCase() || null;
}

export interface MapOptions {
	/**
	 * Publish billing that has no observed usage behind it. Defaults to false
	 * and should stay false anywhere near a signed document.
	 *
	 * This is an explicit flag rather than "pass an empty set" for a reason
	 * worth keeping: an empty set is also what a failed database read returns.
	 * Overloading emptiness to mean "skip the check" made the single most
	 * important guard in this file fail OPEN — one bad query and every Stripe
	 * payment publishes as corroborated with nothing corroborating it. The
	 * default now fails closed: no observed domains means nothing matches.
	 */
	allowUnobserved?: boolean;

	/**
	 * The vendor's own domain, for classifyDomain's self-dealing check. Only
	 * matters for the Letter Company's own vendors billing Letter Company
	 * domains — a genuinely external vendor with a real Letter Company
	 * subscription classifies as `company` either way.
	 */
	vendorDomain?: string;

	/**
	 * Milliseconds since the epoch, for the lapsed-payment rule. Injected
	 * rather than read here so the rule is testable at a fixed instant and this
	 * file keeps having no dependency of its own on the clock.
	 */
	now?: number;
}

/**
 * @param observedDomains domains this vendor has actually been seen serving.
 *   A subscription for a company we have never observed is NOT evidence about
 *   usage — it is evidence about billing, and joining the two is the whole
 *   point of tier 3.
 * @param paidInvoices what actually settled, by subscription id. Required
 *   rather than optional, and for the same reason `allowUnobserved` is an
 *   explicit flag: a corroboration check a caller can forget to pass is a
 *   corroboration check that fails open the first time someone adds a call
 *   site. An empty map means nothing is corroborated, never "skip it".
 */
export function mapPayments(
	subscriptions: StripeSubscriptionLike[],
	observedDomains: ReadonlySet<string>,
	paidInvoices: PaidInvoiceIndex,
	{ allowUnobserved = false, vendorDomain, now = Date.now() }: MapOptions = {}
): PaymentMapping {
	const unmatched: UnmatchedPayment[] = [];
	const byDomain = new Map<string, StripeSubscriptionLike[]>();

	for (const sub of subscriptions) {
		if (!PAYING_STATUSES.has(sub.status)) continue;

		if (!sub.customerEmail) {
			unmatched.push({ subscriptionId: sub.id, reason: "no_email", domain: null });
			continue;
		}

		const domain = domainOfEmail(sub.customerEmail);
		if (!domain || classifyDomain(domain, vendorDomain).kind !== "company") {
			unmatched.push({ subscriptionId: sub.id, reason: "not_a_company", domain });
			continue;
		}

		if (!allowUnobserved && !observedDomains.has(domain)) {
			unmatched.push({ subscriptionId: sub.id, reason: "no_observed_traffic", domain });
			continue;
		}

		// The domain checks come first because they are the ones a vendor can
		// act on, and "we could not attach this payment to a customer" is only
		// useful once you know which customer it was. The money checks below
		// decide whether there is a payment at all.
		const refusal = moneyRefusal(sub, paidInvoices, now);
		if (refusal) {
			unmatched.push({ subscriptionId: sub.id, reason: refusal, domain });
			continue;
		}

		const existing = byDomain.get(domain);
		if (existing) existing.push(sub);
		else byDomain.set(domain, [sub]);
	}

	const matched: DomainPayment[] = [];
	for (const [domain, subs] of byDomain) {
		// One domain paying in two currencies cannot be summed into a single
		// figure without inventing an exchange rate, and inventing one would
		// put a made-up number inside a signed attestation. Refuse instead.
		const currencies = new Set(subs.map((s) => s.currency.toLowerCase()));
		if (currencies.size > 1) {
			for (const s of subs) {
				unmatched.push({ subscriptionId: s.id, reason: "currency_conflict", domain });
			}
			continue;
		}

		const monthlyAmount = subs.reduce((sum, s) => {
			// Non-null by construction: moneyRefusal rejected anything else.
			const months = MONTHS_PER_INTERVAL[s.interval as string];
			// Divide, don't multiply: the constant is months PER interval, so a
			// yearly amount spread over 12 months is amount/12. Getting this
			// backwards published annual contracts at twelve times their value,
			// and annual is the normal enterprise shape — caught by the yearly
			// case in map.test.ts, which is why that test exists.
			return sum + (s.amount as number) / months;
		}, 0);

		// Rounded to the minor unit: a fraction of a cent is not a real amount,
		// and it would differ between runs of the same data. A sum that rounds
		// to nothing is refused rather than published, because `contract_monthly:
		// 0` inside a signed body reads as the claim "pays nothing".
		const rounded = Math.round(monthlyAmount);
		if (rounded < 1) {
			for (const s of subs) unmatched.push({ subscriptionId: s.id, reason: "zero_amount", domain });
			continue;
		}

		// `since` comes from settled invoices, never from `start_date`. Every
		// subscription here has at least one, because moneyRefusal required it.
		const firstSettled = Math.min(
			...subs.map((s) => paidInvoices.get(s.id)?.firstSettledAt ?? Number.POSITIVE_INFINITY)
		);

		matched.push({
			domain,
			since: new Date(firstSettled * 1000).toISOString(),
			currency: [...currencies][0],
			monthlyAmount: rounded,
			subscriptionCount: subs.length,
		});
	}

	matched.sort((a, b) => a.domain.localeCompare(b.domain));
	return { matched, unmatched };
}

/**
 * Why this subscription is not evidence that money moved, or null when it is.
 *
 * WHY THE FLOOR IS SIMPLY "ABOVE ZERO". A larger floor is tempting and it is
 * the wrong instrument. Any figure above zero is denominated in some currency's
 * minor unit, and this file refuses to invent exchange rates elsewhere (see the
 * currency conflict above), so "at least 5000" would mean one thing in USD and
 * something else entirely in JPY or COP. It would also exclude genuinely small
 * customers, who are real customers. And it would not stop anybody: a vendor
 * willing to forge a tier-3 claim will happily pay themselves $50. What makes
 * forgery expensive is the requirement below — a live-mode Stripe account,
 * which Stripe identity-verifies, and a real charge through a real processor
 * that leaves a record in the vendor's own books. The amount is not the barrier;
 * the settled charge is.
 */
function moneyRefusal(
	sub: StripeSubscriptionLike,
	paidInvoices: PaidInvoiceIndex,
	now: number
): UnmatchedReason | null {
	if (sub.amount === null || sub.interval === null) return "no_recurring_amount";
	// The cheap half of the fix. A $0 recurring price goes to `active` the
	// moment it is created, with no payment method and no money, so without
	// this a free subscription published as a paid one.
	if (sub.amount <= 0) return "zero_amount";

	const settled = paidInvoices.get(sub.id);
	if (!settled || settled.settledCount === 0 || settled.lastSettledAt === null) {
		// Named apart from "nothing settled" because the vendor can see the
		// invoice marked paid in their own dashboard, and being told we saw no
		// payment at all would read as our bug rather than as our rule.
		return settled && settled.markedPaidCount > 0 ? "paid_out_of_band" : "no_settled_invoice";
	}

	const window = SETTLED_WITHIN_DAYS[sub.interval] * DAY_MS;
	if (now - settled.lastSettledAt * 1000 > window) return "payment_lapsed";

	return null;
}
