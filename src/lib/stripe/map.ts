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
import type { PaidInvoiceIndex, SettledInvoice } from "./fetch";

/** The subset of a Stripe subscription this mapping needs. */
export interface StripeSubscriptionLike {
	id: string;
	status: string;
	/** Unix seconds, as Stripe sends them. */
	start_date: number;
	currency: string;
	/** The billing interval every item shares. Null when unreadable. */
	interval: "day" | "week" | "month" | "year" | null;
	/** The Stripe products this subscription bills, for the vendor's product scope. */
	productIds: string[];
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
	/** No billing email frozen on the settled invoices — nothing to join on. */
	| "no_email"
	/**
	 * The settled invoices were billed to more than one domain. The billed
	 * identity is the one thing a vendor could move onto a bigger company, so
	 * a subscription whose invoices disagree about who paid is not attributed
	 * to any of them.
	 */
	| "email_changed"
	/** None of this subscription's products are in the vendor's chosen scope. */
	| "out_of_scope"
	/** A person's mailbox, or otherwise not a company identity. */
	| "not_a_company"
	/** A company domain, but one this vendor has never been observed serving. */
	| "no_observed_traffic"
	/** Mixed currencies for one domain — see below. */
	| "currency_conflict"
	/** No readable billing interval, so there is no monthly figure to publish. */
	| "no_recurring_amount"
	/** What settled for the scoped products rounds to nothing per month. */
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

	/**
	 * The Stripe products that are this vendor's product. Null or empty means
	 * every product in the account counts — the behaviour before scopes
	 * existed, and the reason the connection reports which mode it is in.
	 * With a scope, a subscription counts only for the money its invoices
	 * spent on in-scope products.
	 */
	productScope?: ReadonlySet<string> | null;
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
	{ allowUnobserved = false, vendorDomain, now = Date.now(), productScope = null }: MapOptions = {}
): PaymentMapping {
	const unmatched: UnmatchedPayment[] = [];
	const byDomain = new Map<string, Attributed[]>();
	const scope = productScope && productScope.size > 0 ? productScope : null;

	for (const sub of subscriptions) {
		if (!PAYING_STATUSES.has(sub.status)) continue;

		if (scope && !sub.productIds.some((id) => scope.has(id))) {
			unmatched.push({ subscriptionId: sub.id, reason: "out_of_scope", domain: null });
			continue;
		}
		if (sub.interval === null) {
			unmatched.push({ subscriptionId: sub.id, reason: "no_recurring_amount", domain: null });
			continue;
		}

		// Money first now, because the billed identity lives ON the settled
		// invoices: there is no domain to check until we know which invoices
		// count.
		const payments = paidInvoices.get(sub.id);
		const invoices = (payments?.settled ?? [])
			.map((invoice) => ({ invoice, amount: scopedAmount(invoice, scope) }))
			.filter((x) => x.amount > 0);
		if (invoices.length === 0) {
			// Named apart from "nothing settled" because the vendor can see the
			// invoice marked paid in their own dashboard, and being told we saw no
			// payment at all would read as our bug rather than as our rule.
			const reason = payments && payments.markedPaidCount > 0 ? "paid_out_of_band" : "no_settled_invoice";
			unmatched.push({ subscriptionId: sub.id, reason, domain: null });
			continue;
		}

		const domains = new Set(invoices.map((x) => (x.invoice.customerEmail ? domainOfEmail(x.invoice.customerEmail) : null)));
		if (domains.has(null)) {
			unmatched.push({ subscriptionId: sub.id, reason: domains.size > 1 ? "email_changed" : "no_email", domain: null });
			continue;
		}
		if (domains.size > 1) {
			unmatched.push({ subscriptionId: sub.id, reason: "email_changed", domain: null });
			continue;
		}
		const domain = [...domains][0] as string;

		if (classifyDomain(domain, vendorDomain).kind !== "company") {
			unmatched.push({ subscriptionId: sub.id, reason: "not_a_company", domain });
			continue;
		}
		if (!allowUnobserved && !observedDomains.has(domain)) {
			unmatched.push({ subscriptionId: sub.id, reason: "no_observed_traffic", domain });
			continue;
		}

		const last = invoices[invoices.length - 1];
		const window = SETTLED_WITHIN_DAYS[sub.interval] * DAY_MS;
		if (now - last.invoice.paidAt * 1000 > window) {
			unmatched.push({ subscriptionId: sub.id, reason: "payment_lapsed", domain });
			continue;
		}

		// The monthly figure comes from the most recent invoice for a full
		// period. A proration invoice (`subscription_update`) covers a fraction
		// of a period and would misstate the run rate either way, so it is used
		// only when nothing else has settled.
		const periodic = [...invoices].reverse().find((x) => FULL_PERIOD.has(x.invoice.billingReason ?? "")) ?? last;
		const attributed: Attributed = {
			sub,
			currency: periodic.invoice.currency || sub.currency.toLowerCase(),
			// Divide, don't multiply: the constant is months PER interval, so a
			// yearly amount spread over 12 months is amount/12. Getting this
			// backwards published annual contracts at twelve times their value.
			monthly: periodic.amount / MONTHS_PER_INTERVAL[sub.interval],
			firstSettledAt: invoices[0].invoice.paidAt,
		};

		const existing = byDomain.get(domain);
		if (existing) existing.push(attributed);
		else byDomain.set(domain, [attributed]);
	}

	const matched: DomainPayment[] = [];
	for (const [domain, subs] of byDomain) {
		// One domain paying in two currencies cannot be summed into a single
		// figure without inventing an exchange rate, and inventing one would
		// put a made-up number inside a signed attestation. Refuse instead.
		const currencies = new Set(subs.map((s) => s.currency));
		if (currencies.size > 1) {
			for (const s of subs) unmatched.push({ subscriptionId: s.sub.id, reason: "currency_conflict", domain });
			continue;
		}

		// Rounded to the minor unit: a fraction of a cent is not a real amount,
		// and it would differ between runs of the same data. A sum that rounds
		// to nothing is refused rather than published, because `contract_monthly:
		// 0` inside a signed body reads as the claim "pays nothing".
		const rounded = Math.round(subs.reduce((sum, s) => sum + s.monthly, 0));
		if (rounded < 1) {
			for (const s of subs) unmatched.push({ subscriptionId: s.sub.id, reason: "zero_amount", domain });
			continue;
		}

		matched.push({
			domain,
			// From settled invoices, never from `start_date`, which the account
			// owner can backdate to any year they choose.
			since: new Date(Math.min(...subs.map((s) => s.firstSettledAt)) * 1000).toISOString(),
			currency: [...currencies][0],
			monthlyAmount: rounded,
			subscriptionCount: subs.length,
		});
	}

	matched.sort((a, b) => a.domain.localeCompare(b.domain));
	return { matched, unmatched };
}

interface Attributed {
	sub: StripeSubscriptionLike;
	currency: string;
	monthly: number;
	firstSettledAt: number;
}

/** Invoices that bill a whole period, as opposed to a mid-period proration. */
const FULL_PERIOD = new Set(["subscription_cycle", "subscription_create"]);

/**
 * How much of what settled on this invoice was spent on in-scope products.
 *
 * Without a scope, all of it. With one, the in-scope lines' share of the
 * invoice's net line total, applied to what actually settled — so coupons,
 * credits and tax land proportionally rather than being attributed to
 * whichever line happens to be first. An invoice whose lines Stripe truncated
 * cannot be apportioned honestly, so under a scope it counts for nothing:
 * the hidden lines might all be out of scope.
 *
 * WHY THE FLOOR IS SIMPLY "ABOVE ZERO". Any figure above zero is denominated
 * in some currency's minor unit, and this file refuses to invent exchange
 * rates (see the currency conflict above), so a larger floor would mean one
 * thing in USD and another in JPY. What makes forgery expensive is not the
 * amount but the requirement that real money settled through a real processor
 * in a live-mode account.
 */
function scopedAmount(invoice: SettledInvoice, scope: ReadonlySet<string> | null): number {
	if (!scope) return invoice.amountPaid;
	if (!invoice.linesComplete) return 0;
	const total = invoice.lines.reduce((sum, line) => sum + line.net, 0);
	if (total <= 0) return 0;
	const inScope = invoice.lines.reduce((sum, line) => sum + (line.product && scope.has(line.product) ? line.net : 0), 0);
	if (inScope <= 0) return 0;
	return invoice.amountPaid * Math.min(1, inScope / total);
}
