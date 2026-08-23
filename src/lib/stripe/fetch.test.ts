import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchSubscriptions } from "./fetch";

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
