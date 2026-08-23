/**
 * Read a vendor's subscriptions out of Stripe.
 *
 * The only file that talks to Stripe over the network. It does two things and
 * nothing else: page through subscriptions, and flatten each one into the
 * `StripeSubscriptionLike` shape `map.ts` scores. All judgement about what
 * counts as payment evidence lives in map.ts, which is pure and exhaustively
 * tested; keeping that split means the interesting logic never needs a network
 * call to exercise.
 *
 * No SDK. The Stripe node library is a large dependency for two GET requests,
 * and it pulls its own API-version pinning and retry behaviour along with it.
 * A pinned `Stripe-Version` header and `fetch` is the whole requirement here.
 *
 * READ ONLY, and structurally so — there is no code path in this file that
 * issues anything but a GET. A credential that could write is a credential
 * that could refund a vendor's customers, and nothing about publishing proof
 * needs that.
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

interface StripeSubscription {
	id: string;
	status: string;
	start_date: number;
	currency: string;
	items?: { data?: { price?: { unit_amount?: number | null; recurring?: { interval?: string } | null } | null }[] };
	customer?: string | { email?: string | null } | null;
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

		let res: Response;
		try {
			res = await fetch(url, {
				headers: { Authorization: `Bearer ${apiKey}`, "Stripe-Version": STRIPE_VERSION },
			});
		} catch {
			return { ok: false, status: 0, error: "Couldn't reach Stripe." };
		}

		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
			// Stripe's own message is more useful than anything invented here —
			// it names an expired key or a missing permission directly.
			return { ok: false, status: res.status, error: body?.error?.message ?? `Stripe returned ${res.status}` };
		}

		const body = (await res.json()) as { data?: StripeSubscription[]; has_more?: boolean };
		const batch = body.data ?? [];
		for (const sub of batch) subscriptions.push(flatten(sub));

		if (!body.has_more || batch.length === 0) return { ok: true, subscriptions, truncated: false };
		startingAfter = batch[batch.length - 1]?.id;
		if (!startingAfter) return { ok: true, subscriptions, truncated: false };
	}

	// Reported, never silent. A truncated read that looked complete would
	// understate a vendor's evidence without anyone knowing why.
	return { ok: true, subscriptions, truncated: true };
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
