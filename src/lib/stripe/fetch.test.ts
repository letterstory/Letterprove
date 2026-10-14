import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchAccount, fetchPaidInvoices, fetchProducts, fetchSubscriptions } from "./fetch";

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
		items: { data: [{ price: { product: "prod_core", unit_amount: 400000, recurring: { interval: "month" } } }] },
		customer: { email: "billing@acme.com" },
		...extra,
	};
}

function mockJson(pages: ({ data: unknown[]; has_more?: boolean } | Record<string, unknown>)[]) {
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
					interval: "month",
					productIds: ["prod_core"],
				},
			],
		});
	});

	it("asks Stripe for every status and never reads the editable customer record", async () => {
		// status=all because map.ts owns the judgement about what counts as
		// payment. No customer expansion: the billed identity comes from each
		// settled invoice's frozen email, never the customer's current one.
		const calls = mockJson([{ data: [] }]);

		await fetchSubscriptions("sk_test_x");

		expect(calls[0].searchParams.get("status")).toBe("all");
		expect(calls[0].searchParams.get("expand[]")).toBeNull();
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

	it("yields a null interval and no products for a subscription with no readable items", async () => {
		mockJson([{ data: [sub("sub_1", { items: { data: [] } })] }]);

		const result = await fetchSubscriptions("sk_test_x");

		expect(result.ok && result.subscriptions[0]).toMatchObject({ interval: null, productIds: [] });
	});

	it("collects every product a subscription bills, once each", async () => {
		mockJson([
			{
				data: [
					sub("sub_1", {
						items: {
							data: [
								{ price: { product: "prod_a", recurring: { interval: "month" } } },
								{ price: { product: { id: "prod_b" }, recurring: { interval: "month" } } },
								{ price: { product: "prod_a", recurring: { interval: "month" } } },
							],
						},
					}),
				],
			},
		]);

		const result = await fetchSubscriptions("sk_test_x");

		expect(result.ok && result.subscriptions[0].productIds).toEqual(["prod_a", "prod_b"]);
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
		currency: "usd",
		customer_email: "billing@acme.com",
		billing_reason: "subscription_cycle",
		created: 1_770_000_000,
		status_transitions: { paid_at: 1_770_000_100 },
		subscription: "sub_1",
		charge: "ch_1",
		lines: { data: [{ amount: 400000, price: { product: "prod_core" } }], has_more: false },
		...extra,
	};
}

describe("fetchPaidInvoices", () => {
	/*
	 * Why this exists at all: a subscription is what a vendor configured, and an
	 * invoice that settled is the first thing in the chain that cost them money.
	 * Tier 3 claims the second and used to read only the first.
	 */

	it("indexes settled invoices by the subscription they paid for, oldest first", async () => {
		mockJson([{ data: [invoice("in_2", { status_transitions: { paid_at: 1_780_000_000 } }), invoice("in_1")] }]);

		const result = await fetchPaidInvoices("rk_live_x");

		const payments = result.ok && result.payments.get("sub_1");
		expect(payments && payments.settled.map((i) => i.id)).toEqual(["in_1", "in_2"]);
		expect(payments && payments.markedPaidCount).toBe(0);
		expect(payments && payments.settled[0]).toEqual({
			id: "in_1",
			paidAt: 1_770_000_100,
			amountPaid: 400000,
			currency: "usd",
			customerEmail: "billing@acme.com",
			billingReason: "subscription_cycle",
			lines: [{ product: "prod_core", net: 400000 }],
			linesComplete: true,
		});
	});

	it("records the frozen invoice email, what was paid less tax, and each line's net after discounts", async () => {
		mockJson([
			{
				data: [
					invoice("in_1", {
						amount_paid: 55000,
						tax: 5000,
						customer_email: "AP@Acme.com",
						lines: {
							data: [{ amount: 100000, price: { product: "prod_core" }, discount_amounts: [{ amount: 50000 }] }],
							has_more: true,
						},
					}),
				],
			},
		]);

		const result = await fetchPaidInvoices("rk_live_x");
		const settled = result.ok ? result.payments.get("sub_1")?.settled[0] : undefined;

		expect(settled).toMatchObject({
			amountPaid: 50000,
			customerEmail: "AP@Acme.com",
			lines: [{ product: "prod_core", net: 50000 }],
			linesComplete: false,
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

		expect(result.ok && result.payments.get("sub_1")).toEqual({ settled: [], markedPaidCount: 1 });
	});

	it("does not count an invoice marked paid with no processor behind it", async () => {
		// `paid_out_of_band` is a vendor ticking a box in their own dashboard.
		mockJson([{ data: [invoice("in_1", { charge: null, payment_intent: null })] }]);

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok && result.payments.get("sub_1")).toEqual({ settled: [], markedPaidCount: 1 });
	});

	it("accepts a payment intent where there is no charge", async () => {
		mockJson([{ data: [invoice("in_1", { charge: null, payment_intent: "pi_1" })] }]);

		const result = await fetchPaidInvoices("rk_live_x");

		expect(result.ok && result.payments.get("sub_1")?.settled).toHaveLength(1);
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

		expect(result.ok && result.payments.get("sub_9")?.settled).toHaveLength(1);
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

describe("fetchAccount", () => {
	it("collects the domains the account publishes about itself", async () => {
		const calls = mockJson([
			{
				id: "acct_1",
				email: "founder@Acme.com",
				charges_enabled: true,
				country: "us",
				business_profile: { name: "Acme Inc.", url: "https://www.acme.com/", support_email: "help@support.acme.com", support_url: null },
			} as never,
		]);

		const result = await fetchAccount("rk_live_x");

		expect(calls[0].pathname).toBe("/v1/account");
		expect(result).toEqual({
			ok: true,
			account: {
				id: "acct_1",
				domains: ["acme.com", "support.acme.com"],
				charges_enabled: true,
				business_name: "Acme Inc.",
				country: "US",
				business_url_host: "acme.com",
			},
		});
	});

	it("names a missing Accounts permission as a scope problem", async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: false,
			status: 403,
			json: async () => ({ error: { message: "Enabling Accounts Read ('connected_account_read') permissions on this key would allow this request" } }),
		})) as never;

		expect(await fetchAccount("rk_live_x")).toMatchObject({ ok: false, scope: true });
	});
});

describe("fetchProducts", () => {
	it("lists active products and marks the ones with a recurring price", async () => {
		mockJson([
			{ data: [{ id: "prod_b", name: "Beta" }, { id: "prod_a", name: "Alpha" }] },
			{ data: [{ id: "price_1", product: "prod_a" }] },
		]);

		const result = await fetchProducts("rk_live_x");

		expect(result).toEqual({
			ok: true,
			namesAvailable: true,
			products: [
				{ id: "prod_a", name: "Alpha", recurring: true },
				{ id: "prod_b", name: "Beta", recurring: false },
			],
		});
	});

	it("falls back to the products seen on subscriptions when the key cannot read Products", async () => {
		let call = 0;
		globalThis.fetch = vi.fn(async () => {
			call++;
			if (call === 1) {
				return { ok: false, status: 403, json: async () => ({ error: { message: "does not have the required permissions" } }) } as Response;
			}
			return { ok: true, json: async () => ({ data: [sub("sub_1")] }) } as Response;
		}) as never;

		const result = await fetchProducts("rk_live_x");

		expect(result).toEqual({ ok: true, namesAvailable: false, products: [{ id: "prod_core", name: null, recurring: true }] });
	});
});
