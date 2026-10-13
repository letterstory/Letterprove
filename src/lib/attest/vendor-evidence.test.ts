import { beforeEach, describe, expect, it, vi } from "vitest";
import { observedSince, payingAmong, stripeBinding } from "./vendor-evidence";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/vendors/hosts", () => ({ acceptedHosts: vi.fn(async () => new Set()) }));

/** A query builder whose every link chains, resolving to the answer registered for its table. */
function mockDb(byTable: Record<string, { data: unknown; error?: unknown }>) {
	return {
		from: (table: string) => {
			const result = { data: byTable[table]?.data ?? null, error: byTable[table]?.error ?? null };
			const chain: Record<string, unknown> = {};
			for (const m of ["select", "eq", "gte", "gt", "order", "limit"]) chain[m] = () => chain;
			chain.maybeSingle = async () => result;
			chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
			return chain;
		},
	};
}

async function useDb(byTable: Record<string, { data: unknown; error?: unknown }>) {
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(mockDb(byTable) as never);
}

beforeEach(() => vi.clearAllMocks());

describe("stripeBinding", () => {
	const noOverride = { data: { stripe_account_override_account_id: null, stripe_account_override_at: null } };

	it("is domain_match when a domain the account publishes shares the vendor's", async () => {
		await useDb({
			vendor_stripe_credentials: { data: { stripe_account_id: "acct_1", stripe_account_domains: ["billing.acme.com"], account_checked_at: "2026-10-13T00:00:00Z" } },
			vendors: noOverride,
		});
		expect(await stripeBinding("v1", "acme.com")).toBe("domain_match");
	});

	it("is staff_override only for the exact approved account", async () => {
		const cred = { data: { stripe_account_id: "acct_1", stripe_account_domains: ["parent.com"], account_checked_at: "2026-10-13T00:00:00Z" } };
		await useDb({
			vendor_stripe_credentials: cred,
			vendors: { data: { stripe_account_override_account_id: "acct_1", stripe_account_override_at: "2026-10-13T00:00:00Z" } },
		});
		expect(await stripeBinding("v1", "acme.com")).toBe("staff_override");

		await useDb({
			vendor_stripe_credentials: cred,
			vendors: { data: { stripe_account_override_account_id: "acct_other", stripe_account_override_at: "2026-10-13T00:00:00Z" } },
		});
		expect(await stripeBinding("v1", "acme.com")).toBeNull();
	});

	it("is null for a mismatched account, an unread account, or no connection", async () => {
		await useDb({
			vendor_stripe_credentials: { data: { stripe_account_id: "acct_1", stripe_account_domains: ["other.com"], account_checked_at: "2026-10-13T00:00:00Z" } },
			vendors: noOverride,
		});
		expect(await stripeBinding("v1", "acme.com")).toBeNull();

		await useDb({ vendor_stripe_credentials: { data: { stripe_account_id: null, account_checked_at: null } }, vendors: noOverride });
		expect(await stripeBinding("v1", "acme.com")).toBeNull();

		await useDb({ vendor_stripe_credentials: { data: null }, vendors: noOverride });
		expect(await stripeBinding("v1", "acme.com")).toBeNull();
	});

	it("is null when the read fails", async () => {
		await useDb({ vendor_stripe_credentials: { data: null, error: { message: "boom" } }, vendors: noOverride });
		expect(await stripeBinding("v1", "acme.com")).toBeNull();
	});
});

describe("payingAmong", () => {
	it("counts only observed domains with a positive settled amount, and dates from the earliest", async () => {
		await useDb({
			vendor_payment_evidence: {
				data: [
					{ domain: "globex.com", since: "2025-06-01T00:00:00Z", monthly_amount: 5000 },
					{ domain: "initech.com", since: "2025-01-01T00:00:00Z", monthly_amount: "1200" },
					{ domain: "unobserved.com", since: "2024-01-01T00:00:00Z", monthly_amount: 9000 },
					{ domain: "zero.com", since: "2023-01-01T00:00:00Z", monthly_amount: 0 },
				],
			},
		});
		expect(await payingAmong("v1", ["globex.com", "initech.com", "zero.com", "quiet.com"])).toEqual({
			companies: 2,
			since: "2025-01-01T00:00:00.000Z",
		});
	});

	it("claims nothing when the read fails or nothing was observed", async () => {
		await useDb({ vendor_payment_evidence: { data: null, error: { message: "boom" } } });
		expect(await payingAmong("v1", ["globex.com"])).toEqual({ companies: 0, since: null });
		expect(await payingAmong("v1", [])).toEqual({ companies: 0, since: null });
	});
});

describe("observedSince", () => {
	it("is the oldest frozen attestation that counted a company", async () => {
		await useDb({ published_aggregates: { data: { published_at: "2026-09-03T01:05:00+00:00" } } });
		expect(await observedSince("acme")).toBe("2026-09-03T01:05:00.000Z");
	});

	it("is null with no such row or a failed read", async () => {
		await useDb({ published_aggregates: { data: null } });
		expect(await observedSince("acme")).toBeNull();
		await useDb({ published_aggregates: { data: null, error: { message: "boom" } } });
		expect(await observedSince("acme")).toBeNull();
	});
});
