/**
 * Read a vendor's subscriptions, and the invoices that actually settled, out
 * of Stripe.
 *
 * The only file that talks to Stripe over the network. It does two things and
 * nothing else: page through a list, and flatten each object into the shape
 * `map.ts` scores. All judgement about what counts as payment evidence lives
 * in map.ts, which is pure and exhaustively tested; keeping that split means
 * the interesting logic never needs a network call to exercise.
 *
 * No SDK. The Stripe node library is a large dependency for two list calls,
 * and it pulls its own API-version pinning and retry behaviour along with it.
 * A pinned `Stripe-Version` header and `fetch` is the whole requirement here.
 *
 * READ ONLY, and structurally so — every request in this file goes through
 * `get()`, which has no way to express a method other than GET. A credential
 * that could write is a credential that could refund a vendor's customers, and
 * nothing about publishing proof needs that.
 *
 * WHY INVOICES ARE READ AT ALL. A subscription says what a vendor intends to
 * bill. It does not say that anyone paid: a subscription on a $0 recurring
 * price, or on a 100%-off coupon, goes to `active` immediately with no payment
 * method and no money, which made a tier-3 claim free to manufacture in the
 * vendor's own account. An invoice that settled is the first artefact in this
 * chain that a vendor cannot produce by typing — it costs them a real charge
 * through a real processor. That is the whole reason tier 3 claims to escape
 * vendor origination, so it is the thing we have to read.
 */

import type { StripeSubscriptionLike } from "./map";

/**
 * Pinned deliberately. Stripe changes response shapes between versions, and an
 * unpinned integration silently starts reading a different document the day
 * they roll one out — which for us would mean amounts or intervals quietly
 * changing meaning inside a signed attestation.
 */
const STRIPE_VERSION = "2024-06-20";
const API = "https://api.stripe.com/v1";
/** Stripe's per-page maximum. Fewer round trips, same result. */
const PAGE_SIZE = 100;
/** A vendor with more than this many subscriptions needs incremental sync, not a bigger loop. */
const MAX_PAGES = 50;

export type FetchResult =
	| { ok: true; subscriptions: StripeSubscriptionLike[]; truncated: boolean }
	| { ok: false; status: number; error: string };

/** What actually settled against one subscription. */
export interface SubscriptionPayments {
	/**
	 * Unix seconds of the earliest settled invoice we read.
	 *
	 * This, not `subscription.start_date`, is the honest answer to "since
	 * when". A start date is a field the account owner sets and can backdate to
	 * any year they like; a settled invoice is dated by Stripe at the moment
	 * money moved, and no parameter moves it into the past. Null when nothing
	 * settled, which is a different thing from a date of zero.
	 */
	firstSettledAt: number | null;
	/** Unix seconds of the most recent settled invoice. Feeds the staleness rule in map.ts. */
	lastSettledAt: number | null;
	/** Invoices that were paid, for a non-zero amount, through a processor. */
	settledCount: number;
	/**
	 * Invoices Stripe reports as paid with no charge or payment intent behind
	 * them — the `paid_out_of_band` shape, which is a vendor ticking a box.
	 * Counted separately so map.ts can say why it refused rather than reporting
	 * "no payment" about an invoice the vendor can see marked paid.
	 */
	markedPaidCount: number;
}

export type PaidInvoiceIndex = ReadonlyMap<string, SubscriptionPayments>;

export type InvoiceFetchResult =
	| { ok: true; payments: PaidInvoiceIndex; truncated: boolean }
	| {
			ok: false;
			status: number;
			error: string;
			/**
			 * True when Stripe refused for want of a permission rather than for a
			 * bad key. Restricted-key scopes are per resource, so a key created
			 * against the old setup copy can read Subscriptions and Customers and
			 * nothing else. The caller has to tell "add Invoices read to your key"
			 * apart from "your key expired", because they are different actions.
			 */
			scope: boolean;
	  };

interface StripeSubscription {
	id: string;
	status: string;
	start_date: number;
	currency: string;
	items?: { data?: { price?: { unit_amount?: number | null; recurring?: { interval?: string } | null } | null }[] };
	customer?: string | { email?: string | null } | null;
}

interface StripeInvoice {
	id: string;
	amount_paid?: number | null;
	created?: number | null;
	status_transitions?: { paid_at?: number | null } | null;
	/** Present on the pinned version. `parent` is the shape later versions moved to. */
	subscription?: string | { id?: string } | null;
	parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
	charge?: string | { id?: string } | null;
	payment_intent?: string | { id?: string } | null;
}

interface StripeError {
	status: number;
	error: string;
}

/**
 * One GET, and there is deliberately no way to ask this for anything else.
 * Every Stripe call in this file goes through here, so "read only" is a
 * property of the file's shape rather than a promise in a comment.
 */
async function get<T>(url: URL, apiKey: string): Promise<{ ok: true; body: T } | { ok: false; failure: StripeError }> {
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, "Stripe-Version": STRIPE_VERSION },
		});
	} catch {
		return { ok: false, failure: { status: 0, error: "Couldn't reach Stripe." } };
	}

	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
		// Stripe's own message is more useful than anything invented here —
		// it names an expired key or a missing permission directly.
		return {
			ok: false,
			failure: { status: res.status, error: body?.error?.message ?? `Stripe returned ${res.status}` },
		};
	}

	return { ok: true, body: (await res.json()) as T };
}

export async function fetchSubscriptions(apiKey: string): Promise<FetchResult> {
	const subscriptions: StripeSubscriptionLike[] = [];
	let startingAfter: string | undefined;

	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL(`${API}/subscriptions`);
		url.searchParams.set("limit", String(PAGE_SIZE));
		// Every status, not just active: map.ts decides what counts as payment,
		// and asking Stripe to pre-filter would move that judgement into a query
		// string where it is invisible and untested.
		url.searchParams.set("status", "all");
		// Saves a second request per customer. The alternative — fetching each
		// customer to read its email — is one round trip per subscription.
		url.searchParams.set("expand[]", "data.customer");
		if (startingAfter) url.searchParams.set("starting_after", startingAfter);

		const res = await get<{ data?: StripeSubscription[]; has_more?: boolean }>(url, apiKey);
		if (!res.ok) return { ok: false, ...res.failure };

		const batch = res.body.data ?? [];
		for (const sub of batch) subscriptions.push(flatten(sub));

		if (!res.body.has_more || batch.length === 0) return { ok: true, subscriptions, truncated: false };
		startingAfter = batch[batch.length - 1]?.id;
		if (!startingAfter) return { ok: true, subscriptions, truncated: false };
	}

	// Reported, never silent. A truncated read that looked complete would
	// understate a vendor's evidence without anyone knowing why.
	return { ok: true, subscriptions, truncated: true };
}

/**
 * Every paid invoice in the account, indexed by the subscription it settled.
 *
 * Account-wide with one paged list, not one request per subscription. Asking
 * `?subscription=` per subscription is a round trip per customer, which for a
 * vendor with a few hundred customers is a few hundred calls against somebody
 * else's rate limit every hour.
 *
 * No `created` lower bound, because `firstSettledAt` is a tenure claim and a
 * window would silently shorten it: a customer who has paid since 2021 would
 * publish as having paid since whenever the window opened. Truncation is
 * reported instead, and a truncated read understates tenure rather than
 * inventing it — the safe direction, and one the caller can alert on.
 */
export async function fetchPaidInvoices(apiKey: string): Promise<InvoiceFetchResult> {
	const payments = new Map<string, SubscriptionPayments>();
	let startingAfter: string | undefined;

	for (let page = 0; page < MAX_PAGES; page++) {
		const url = new URL(`${API}/invoices`);
		url.searchParams.set("limit", String(PAGE_SIZE));
		// Filtered at Stripe, unlike subscriptions above, and for a reason that
		// does not contradict that choice: `status` here is not the judgement.
		// map.ts still decides what a settled invoice means; this only avoids
		// paging through drafts and voids that could never qualify.
		url.searchParams.set("status", "paid");
		if (startingAfter) url.searchParams.set("starting_after", startingAfter);

		const res = await get<{ data?: StripeInvoice[]; has_more?: boolean }>(url, apiKey);
		if (!res.ok) {
			return { ok: false, ...res.failure, scope: isScopeFailure(res.failure) };
		}

		const batch = res.body.data ?? [];
		for (const invoice of batch) record(payments, invoice);

		if (!res.body.has_more || batch.length === 0) return { ok: true, payments, truncated: false };
		startingAfter = batch[batch.length - 1]?.id;
		if (!startingAfter) return { ok: true, payments, truncated: false };
	}

	return { ok: true, payments, truncated: true };
}

/**
 * A permission refusal, not a bad credential.
 *
 * Stripe answers a restricted key that lacks a resource with 403 and a message
 * naming the missing permission. Matched on the message as well as the status
 * so the classification does not hinge on one status code staying put — and a
 * misclassification here is only ever the difference between two error strings
 * shown to the vendor, never the difference between publishing and not.
 */
function isScopeFailure({ status, error }: StripeError): boolean {
	return status === 403 || /permission/i.test(error);
}

function idOf(ref: string | { id?: string } | null | undefined): string | null {
	if (typeof ref === "string") return ref || null;
	if (ref && typeof ref === "object") return ref.id ?? null;
	return null;
}

function record(payments: Map<string, SubscriptionPayments>, invoice: StripeInvoice): void {
	const subscriptionId =
		idOf(invoice.subscription) ?? idOf(invoice.parent?.subscription_details?.subscription);
	// A one-off invoice with no subscription behind it is real money, but it is
	// money we cannot attach to the recurring relationship tier 3 describes.
	if (!subscriptionId) return;

	const paidAt = invoice.status_transitions?.paid_at ?? invoice.created;
	if (typeof paidAt !== "number") return;

	// Stripe marks a zero invoice paid without anyone paying anything, so the
	// amount is load bearing: this is the check a 100%-off coupon fails.
	const amountPaid = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
	// A charge or payment intent is the processor's own record. Without one the
	// invoice was marked paid by hand (`paid_out_of_band`), which is the vendor
	// asserting payment — exactly the thing tier 3 is supposed to be free of.
	const processed = Boolean(idOf(invoice.charge) ?? idOf(invoice.payment_intent));
	const settled = amountPaid > 0 && processed;

	const existing = payments.get(subscriptionId);
	if (!existing) {
		payments.set(subscriptionId, {
			firstSettledAt: settled ? paidAt : null,
			lastSettledAt: settled ? paidAt : null,
			settledCount: settled ? 1 : 0,
			markedPaidCount: settled ? 0 : 1,
		});
		return;
	}

	if (!settled) {
		existing.markedPaidCount++;
		return;
	}

	existing.settledCount++;
	existing.firstSettledAt = existing.firstSettledAt === null ? paidAt : Math.min(existing.firstSettledAt, paidAt);
	existing.lastSettledAt = existing.lastSettledAt === null ? paidAt : Math.max(existing.lastSettledAt, paidAt);
}

function flatten(sub: StripeSubscription): StripeSubscriptionLike {
	// First item only. Multi-item subscriptions exist, but summing prices across
	// items would invent a figure for a shape we have never seen in practice —
	// and map.ts already tolerates a null amount rather than counting it as
	// zero-cost, so an unhandled shape is visibly absent instead of wrong.
	const price = sub.items?.data?.[0]?.price;
	const interval = price?.recurring?.interval;

	return {
		id: sub.id,
		status: sub.status,
		start_date: sub.start_date,
		currency: sub.currency,
		amount: typeof price?.unit_amount === "number" ? price.unit_amount : null,
		interval:
			interval === "day" || interval === "week" || interval === "month" || interval === "year"
				? interval
				: null,
		// Expanded above. A string here means expansion didn't happen, in which
		// case there is no email to read and map.ts reports it as unmatched
		// rather than guessing.
		customerEmail:
			sub.customer && typeof sub.customer === "object" ? (sub.customer.email ?? null) : null,
	};
}
