import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchPaidInvoices, fetchSubscriptions } from "./fetch";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

function sub(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		status: "active",
		start_date: 1_770_000_000,
		currency: "usd",
		items: { data: [{ price: { unit_amount: 400000, recurring: { interval: "month" } } }] },
		customer: { email: "billing@acme.com" },
		...extra,
	};
}

function mockJson(pages: { data: unknown[]; has_more?: boolean }[]) {
	const calls: URL[] = [];
	let i = 0;
	globalThis.fetch = vi.fn(async (url: string | URL) => {
		calls.push(new URL(String(url)));
		const page = pages[i++] ?? { data: [] };
		return { ok: true, json: async () => page } as Response;
	}) as never;
	return calls;
}

describe("fetchSubscriptions", () => {
	it("flattens a subscription into the shape map.ts scores", async () => {
		mockJson([{ data: [sub("sub_1")] }]);

		const result = await fetchSubscriptions("sk_test_x");

		expect(result).toEqual({
			ok: true,
			truncated: false,
			subscriptions: [
				{
					id: "sub_1",
					status: "active",
					start_date: 1_770_000_000,
					currency: "usd",
					amount: 400000,
					interval: "month",
					customerEmail: "billing@acme.com",
				},
			],
		});
	});

	it("asks Stripe for every status and expands the customer", async () => {
		// status=all because map.ts owns the judgement about what counts as
		// payment; pre-filtering here would hide that decision in a query string.
		// The expand saves one request per subscription.
		const calls = mockJson([{ data: [] }]);

		await fetchSubscriptions("sk_test_x");

		expect(calls[0].searchParams.get("status")).toBe("all");
		expect(calls[0].searchParams.get("expand[]")).toBe("data.customer");
	});

	it("pins the API version, so a Stripe rollout cannot change what amounts mean", async () => {
		const headers: Record<string, string>[] = [];
		globalThis.fetch = vi.fn(async (_u: unknown, init: RequestInit) => {
			headers.push(init.headers as Record<string, string>);
			return { ok: true, json: async () => ({ data: [] }) } as Response;
		}) as never;

		await fetchSubscriptions("sk_test_x");

		expect(headers[0]["Stripe-Version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("pages until has_more is false", async () => {
		const calls = mockJson([
			{ data: [sub("sub_1")], has_more: true },
			{ data: [sub("sub_2")], has_more: false },
		]);

		const result = await fetchSubscriptions("sk_test_x");

		expect(result.ok && result.subscriptions.map((s) => s.id)).toEqual(["sub_1", "sub_2"]);
		expect(calls[1].searchParams.get("starting_after")).toBe("sub_1");
	});

	it("reports truncation rather than silently returning a partial read", async () => {
		// A short read that looked complete would understate a vendor's evidence
		// with nobody able to tell why.
		mockJson(Array.from({ length: 60 }, () => ({ data: [sub("sub_x")], has_more: true })));

		const result = await fetchSubscriptions("sk_test_x");

		expect(result.ok && result.truncated).toBe(true);
	});

	it("surfaces Stripe's own error message", async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 401,
			json: async () => ({ error: { message: "Expired API Key provided" } }),
		})) as never;

		const result = await fetchSubscriptions("sk_test_bad");

		expect(result).toEqual({ ok: false, status: 401, error: "Expired API Key provided" });
	});

	it("returns a failure rather than throwing when Stripe is unreachable", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as never;

		const result = await fetchSubscriptions("sk_test_x");

		expect(result).toEqual({ ok: false, status: 0, error: "Couldn't reach Stripe." });
	});

	it("yields a null amount rather than zero for an unreadable price", async () => {
		// map.ts tolerates null and counts nothing; a zero would publish the
		// customer as paying nothing, which is a different and false claim.
		mockJson([{ data: [sub("sub_1", { items: { data: [] } })] }]);

		const result = await fetchSubscriptions("sk_test_x");

		expect(result.ok && result.subscriptions[0]).toMatchObject({ amount: null, interval: null });
	});

	it("yields a null email when the customer was not expanded", async () => {
		mockJson([{ data: [sub("sub_1", { customer: "cus_123" })] }]);

		const result = await fetchSubscriptions("sk_test_x");

		expect(result.ok && result.subscriptions[0].customerEmail).toBeNull();
	});

	it("ignores an interval Stripe adds later rather than mis-scaling it", async () => {
		mockJson([
			{ data: [sub("sub_1", { items: { data: [{ price: { unit_amount: 100, recurring: { interval: "fortnight" } } }] } })] },
		]);

		const result = await fetchSubscriptions("sk_test_x");

		expect(result.ok && result.subscriptions[0].interval).toBeNull();
	});
});

function invoice(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		amount_paid: 400000,
		created: 1_770_000_000,
		status_transitions: { paid_at: 1_770_000_100 },
		subscription: "sub_1",
		charge: "ch_1",
		...extra,
	};
}

describe("fetchPaidInvoices", () => {
	/*
	 * Why this exists at all: a subscription is what a vendor configured, and an
	 * invoice that settled is the first thing in the chain that cost them money.
	 * Tier 3 claims the second and used to read only the first.
	 */

	it("indexes settled invoices by the subscription they paid for", async () => {
		mockJson([{ data: [invoice("in_1"), invoice("in_2", { status_transitions: { paid_at: 1_780_000_000 } })] }]);

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok).toBe(true);
		const payments = result.ok && result.payments.get("sub_1");
		expect(payments).toEqual({
			firstSettledAt: 1_770_000_100,
			lastSettledAt: 1_780_000_000,
			settledCount: 2,
			markedPaidCount: 0,
		});
	});

	it("asks Stripe only for paid invoices", async () => {
		const calls = mockJson([{ data: [] }]);

		await fetchPaidInvoices("rk_live_x");

		expect(calls[0].searchParams.get("status")).toBe("paid");
	});

	it("does not count a zero invoice, which Stripe marks paid with nobody paying", async () => {
		// The 100%-off coupon shape, and the reason the amount is read rather
		// than trusting `status: paid`.
		mockJson([{ data: [invoice("in_1", { amount_paid: 0 })] }]);

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok && result.payments.get("sub_1")).toMatchObject({ settledCount: 0, markedPaidCount: 1 });
	});

	it("does not count an invoice marked paid with no processor behind it", async () => {
		// `paid_out_of_band` is a vendor ticking a box in their own dashboard.
		mockJson([{ data: [invoice("in_1", { charge: null, payment_intent: null })] }]);

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok && result.payments.get("sub_1")).toMatchObject({
			settledCount: 0,
			markedPaidCount: 1,
			firstSettledAt: null,
		});
	});

	it("accepts a payment intent where there is no charge", async () => {
		mockJson([{ data: [invoice("in_1", { charge: null, payment_intent: "pi_1" })] }]);

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok && result.payments.get("sub_1")).toMatchObject({ settledCount: 1 });
	});

	it("ignores an invoice with no subscription behind it", async () => {
		// Real money, but not money we can attach to the recurring relationship
		// a tier-3 claim describes.
		mockJson([{ data: [invoice("in_1", { subscription: null })] }]);

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok && result.payments.size).toBe(0);
	});

	it("reads the subscription out of the shape a later API version moved it to", async () => {
		// Defensive rather than needed today: the version header is pinned, and
		// the day somebody bumps it this keeps tenure from silently emptying.
		mockJson([
			{ data: [invoice("in_1", { subscription: null, parent: { subscription_details: { subscription: "sub_9" } } })] },
		]);

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok && result.payments.get("sub_9")).toMatchObject({ settledCount: 1 });
	});

	it("names a permission refusal apart from a bad key", async () => {
		// Every restricted key created against the old setup copy can read
		// Subscriptions and Customers and nothing else, and "add Invoices read"
		// is a different instruction from "your key expired".
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 403,
			json: async () => ({ error: { message: "The provided key does not have the required permissions." } }),
		})) as never;

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result).toMatchObject({ ok: false, status: 403, scope: true });
	});

	it("does not call an expired key a permission problem", async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 401,
			json: async () => ({ error: { message: "Expired API Key provided" } }),
		})) as never;

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result).toMatchObject({ ok: false, status: 401, scope: false });
	});

	it("pages, and reports truncation rather than silently shortening tenure", async () => {
		mockJson(Array.from({ length: 60 }, () => ({ data: [invoice("in_x")], has_more: true })));

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok && result.truncated).toBe(true);
	});

	it("returns a failure rather than throwing when Stripe is unreachable", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as never;

		expect(await fetchPaidInvoices("rk_live_x")).toMatchObject({ ok: false, status: 0, scope: false });
	});
});
