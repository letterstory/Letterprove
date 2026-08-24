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
 * no clock, no database. It can be tested exhaustively without a Stripe account,
 * which matters because the join below is where this feature is most likely to
 * be quietly wrong.
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
 */

import { classifyDomain } from "@/lib/identity/domains";

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
	/** Earliest start across this domain's active subscriptions, ISO. */
	since: string;
	currency: string;
	/** Total recurring amount per month, in the currency's minor unit. */
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
	| "currency_conflict";

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
 * Subscription statuses that represent money actually flowing. `trialing` is
 * deliberately excluded: a trial is not a paying customer, and tier 3's entire
 * claim is that payment corroborates usage. `past_due` is also excluded —
 * the relationship exists but the payment has not landed, and publishing it as
 * paid would overstate.
 */
const PAYING_STATUSES = new Set(["active"]);

/** Per-month equivalents, so mixed billing intervals can be summed. */
const MONTHS_PER_INTERVAL: Record<string, number> = {
	day: 1 / 30,
	week: 1 / 4.345,
	month: 1,
	year: 12,
};

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
}

/**
 * @param observedDomains domains this vendor has actually been seen serving.
 *   A subscription for a company we have never observed is NOT evidence about
 *   usage — it is evidence about billing, and joining the two is the whole
 *   point of tier 3.
 */
export function mapPayments(
	subscriptions: StripeSubscriptionLike[],
	observedDomains: ReadonlySet<string>,
	{ allowUnobserved = false, vendorDomain }: MapOptions = {}
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
			if (s.amount === null || s.interval === null) return sum;
			const months = MONTHS_PER_INTERVAL[s.interval];
			// Divide, don't multiply: the constant is months PER interval, so a
			// yearly amount spread over 12 months is amount/12. Getting this
			// backwards published annual contracts at twelve times their value,
			// and annual is the normal enterprise shape — caught by the yearly
			// case in map.test.ts, which is why that test exists.
			if (!months) return sum;
			return sum + s.amount / months;
		}, 0);

		matched.push({
			domain,
			since: new Date(Math.min(...subs.map((s) => s.start_date)) * 1000).toISOString(),
			currency: [...currencies][0],
			// Rounded to the minor unit: a fraction of a cent is not a real
			// amount, and it would differ between runs of the same data.
			monthlyAmount: Math.round(monthlyAmount),
			subscriptionCount: subs.length,
		});
	}

	matched.sort((a, b) => a.domain.localeCompare(b.domain));
	return { matched, unmatched };
}
