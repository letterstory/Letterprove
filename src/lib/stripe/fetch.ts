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

/**
 * One invoice that settled through a processor for a non-zero amount, as the
 * evidence for it was frozen by Stripe.
 *
 * WHY THE INVOICE AND NOT THE CUSTOMER. A customer record's email is a field
 * the account owner edits whenever they like, so joining on it let a vendor
 * move a small payer's real money onto any bigger company it had observed —
 * change `billing@small.io` to `cto@bigco.com` and bigco published as a paying
 * customer, for free. `invoice.customer_email` is copied onto the invoice when
 * it is finalised and cannot be edited afterwards, so it says who was billed at
 * the moment money moved. Likewise the amount: `amount_paid` is what settled,
 * where a price's `unit_amount` is the list price before quantity, coupons and
 * every other line on the invoice.
 */
export interface SettledInvoice {
	id: string;
	/** Unix seconds, stamped by Stripe when the payment landed. */
	paidAt: number;
	/** What settled, in the currency's minor unit, less tax. Always positive. */
	amountPaid: number;
	currency: string;
	/** The billing email Stripe froze on the invoice at finalisation. */
	customerEmail: string | null;
	/** `subscription_cycle`, `subscription_create`, `subscription_update` (proration)… */
	billingReason: string | null;
	/** Each line's product and net amount (after its discounts), for product scope. */
	lines: InvoiceLine[];
	/** False when Stripe returned only the first page of lines. */
	linesComplete: boolean;
}

export interface InvoiceLine {
	product: string | null;
	/** Minor units after the line's own discounts. May be negative (credits). */
	net: number;
}

/** What actually settled against one subscription. */
export interface SubscriptionPayments {
	/**
	 * Every settled invoice, oldest first. map.ts derives tenure, recency, the
	 * billed domain and the monthly figure from these — after applying the
	 * vendor's product scope, which is why the raw invoices travel rather than
	 * pre-computed totals.
	 */
	settled: SettledInvoice[];
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
	items?: {
		data?: {
			price?: { product?: string | { id?: string } | null; recurring?: { interval?: string } | null } | null;
		}[];
	};
}

interface StripeInvoice {
	id: string;
	amount_paid?: number | null;
	/** Tax on the invoice, so the published figure is the contract, not the government's share. */
	tax?: number | null;
	currency?: string | null;
	customer_email?: string | null;
	billing_reason?: string | null;
	created?: number | null;
	status_transitions?: { paid_at?: number | null } | null;
	/** Present on the pinned version. `parent` is the shape later versions moved to. */
	subscription?: string | { id?: string } | null;
	parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
	charge?: string | { id?: string } | null;
	payment_intent?: string | { id?: string } | null;
	lines?: {
		data?: {
			amount?: number | null;
			price?: { product?: string | { id?: string } | null } | null;
			discount_amounts?: { amount?: number | null }[] | null;
		}[];
		has_more?: boolean;
	} | null;
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
		// No customer expansion. The billed identity comes from each settled
		// invoice's frozen email (see SettledInvoice), never from the editable
		// customer record, so there is nothing on the customer worth reading.
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
 * No `created` lower bound, because the first settled invoice is a tenure claim and a
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
	const tax = typeof invoice.tax === "number" && invoice.tax > 0 ? invoice.tax : 0;
	// A charge or payment intent is the processor's own record. Without one the
	// invoice was marked paid by hand (`paid_out_of_band`), which is the vendor
	// asserting payment — exactly the thing tier 3 is supposed to be free of.
	const processed = Boolean(idOf(invoice.charge) ?? idOf(invoice.payment_intent));
	const net = amountPaid - tax;
	const settled = amountPaid > 0 && net > 0 && processed;

	let entry = payments.get(subscriptionId);
	if (!entry) {
		entry = { settled: [], markedPaidCount: 0 };
		payments.set(subscriptionId, entry);
	}

	if (!settled) {
		entry.markedPaidCount++;
		return;
	}

	entry.settled.push({
		id: invoice.id,
		paidAt,
		amountPaid: net,
		currency: (invoice.currency ?? "").toLowerCase(),
		customerEmail: invoice.customer_email ?? null,
		billingReason: invoice.billing_reason ?? null,
		lines: (invoice.lines?.data ?? []).map((line) => {
			const discounts = (line.discount_amounts ?? []).reduce((sum, d) => sum + (typeof d.amount === "number" ? d.amount : 0), 0);
			return {
				product: idOf(line.price?.product ?? null),
				net: (typeof line.amount === "number" ? line.amount : 0) - discounts,
			};
		}),
		linesComplete: !invoice.lines?.has_more,
	});
	entry.settled.sort((a, b) => a.paidAt - b.paidAt);
}

function flatten(sub: StripeSubscription): StripeSubscriptionLike {
	// The interval of the first item. Stripe requires every item on a
	// subscription to share one billing interval, so the first speaks for all.
	const items = sub.items?.data ?? [];
	const interval = items[0]?.price?.recurring?.interval;
	const productIds = [
		...new Set(items.map((item) => idOf(item.price?.product ?? null)).filter((id): id is string => Boolean(id))),
	];

	return {
		id: sub.id,
		status: sub.status,
		start_date: sub.start_date,
		currency: sub.currency,
		interval:
			interval === "day" || interval === "week" || interval === "month" || interval === "year"
				? interval
				: null,
		productIds,
	};
}

// ------------------------------------------------------------ the account

export interface StripeAccountIdentity {
	id: string;
	/** Registrable-domain candidates the account owner published about itself. */
	domains: string[];
	/**
	 * Whether Stripe lets the account accept payments. Stripe turns this on only
	 * after it has verified the business (legal entity, the people behind it, a
	 * bank account), so it is the one fact here Stripe checked rather than the
	 * owner typed. Null when the response didn't say.
	 */
	charges_enabled?: boolean | null;
	/** The business name the account shows (business profile, else the dashboard display name). */
	business_name?: string | null;
	/** Two-letter country of the account. */
	country?: string | null;
	/** Host of the business website on the account, if any. */
	business_url_host?: string | null;
}

export type AccountFetchResult =
	| { ok: true; account: StripeAccountIdentity }
	| { ok: false; status: number; error: string; scope: boolean };

/**
 * Which business the connected Stripe account says it is.
 *
 * Needs the restricted key's "Accounts: Read" permission (Stripe calls it
 * `connected_account_read`). Read on every connect and every sync, because the
 * key — and therefore the account — can be swapped at any time.
 */
export async function fetchAccount(apiKey: string): Promise<AccountFetchResult> {
	const res = await get<{
		id?: string;
		email?: string | null;
		charges_enabled?: boolean | null;
		country?: string | null;
		business_profile?: { name?: string | null; url?: string | null; support_email?: string | null; support_url?: string | null } | null;
		settings?: { dashboard?: { display_name?: string | null } | null } | null;
	}>(new URL(`${API}/account`), apiKey);
	if (!res.ok) return { ok: false, ...res.failure, scope: isScopeFailure(res.failure) };

	const body = res.body;
	const profile = body.business_profile ?? {};
	const hosts = [hostOf(profile.url), hostOf(profile.support_url), emailHost(profile.support_email), emailHost(body.email)];
	return {
		ok: true,
		account: {
			id: body.id ?? "",
			domains: [...new Set(hosts.filter((h): h is string => Boolean(h)))],
			charges_enabled: typeof body.charges_enabled === "boolean" ? body.charges_enabled : null,
			business_name: (profile.name || body.settings?.dashboard?.display_name || "").trim() || null,
			country: typeof body.country === "string" && body.country ? body.country.toUpperCase() : null,
			business_url_host: hostOf(profile.url),
		},
	};
}

function hostOf(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "") || null;
	} catch {
		return null;
	}
}

function emailHost(email: string | null | undefined): string | null {
	if (!email) return null;
	const at = email.lastIndexOf("@");
	return at > 0 ? email.slice(at + 1).trim().toLowerCase() || null : null;
}

// ----------------------------------------------------------- the products

export interface StripeProduct {
	id: string;
	/** Null when the key cannot read Products and the id came from a subscription. */
	name: string | null;
	/** Whether the product has an active recurring price. Null when Prices cannot be read. */
	recurring: boolean | null;
}

export type ProductsFetchResult =
	| { ok: true; products: StripeProduct[]; namesAvailable: boolean }
	| { ok: false; status: number; error: string };

/**
 * The account's products, so a vendor can say which of them are this product.
 *
 * A Stripe account often bills more than one product, and every subscription
 * in it used to count as payment for this vendor's product. Products and
 * Prices read are optional extras on the key: without them the list falls back
 * to the product ids seen on subscriptions, unnamed, which is enough to pick
 * from in the Stripe dashboard.
 */
export async function fetchProducts(apiKey: string): Promise<ProductsFetchResult> {
	const products = new Map<string, StripeProduct>();
	let namesAvailable = true;

	const listed = await listAll<{ id: string; name?: string | null }>(apiKey, "products", { active: "true" });
	if (listed.ok) {
		for (const p of listed.items) products.set(p.id, { id: p.id, name: p.name ?? null, recurring: null });
	} else if (isScopeFailure(listed.failure)) {
		namesAvailable = false;
		const subs = await fetchSubscriptions(apiKey);
		if (!subs.ok) return { ok: false, status: subs.status, error: subs.error };
		for (const sub of subs.subscriptions) {
			for (const id of sub.productIds) if (!products.has(id)) products.set(id, { id, name: null, recurring: true });
		}
		return { ok: true, products: [...products.values()].sort((a, b) => a.id.localeCompare(b.id)), namesAvailable };
	} else {
		return { ok: false, ...listed.failure };
	}

	const prices = await listAll<{ id?: string; product?: string | { id?: string } | null }>(apiKey, "prices", {
		active: "true",
		type: "recurring",
	});
	if (prices.ok) {
		const recurring = new Set(prices.items.map((p) => idOf(p.product ?? null)).filter(Boolean));
		for (const product of products.values()) product.recurring = recurring.has(product.id);
	}

	return {
		ok: true,
		products: [...products.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
		namesAvailable,
	};
}

async function listAll<T extends { id?: string }>(
	apiKey: string,
	resource: string,
	params: Record<string, string>,
): Promise<{ ok: true; items: T[] } | { ok: false; failure: StripeError }> {
	const items: T[] = [];
	let startingAfter: string | undefined;
	for (let page = 0; page < 10; page++) {
		const url = new URL(`${API}/${resource}`);
		url.searchParams.set("limit", String(PAGE_SIZE));
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		if (startingAfter) url.searchParams.set("starting_after", startingAfter);
		const res = await get<{ data?: T[]; has_more?: boolean }>(url, apiKey);
		if (!res.ok) return { ok: false, failure: res.failure };
		const batch = res.body.data ?? [];
		items.push(...batch);
		startingAfter = batch[batch.length - 1]?.id;
		if (!res.body.has_more || !startingAfter) break;
	}
	return { ok: true, items };
}
