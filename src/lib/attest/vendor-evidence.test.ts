import { beforeEach, describe, expect, it, vi } from "vitest";
import { observedSince, stripeBinding, stripeBusiness, stripeBusinessConfirms } from "./vendor-evidence";

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

describe("stripeBusiness", () => {
	const noOverride = { data: { stripe_account_override_account_id: null, stripe_account_override_at: null } };
	const now = new Date().toISOString();
	const cred = (extra: Record<string, unknown> = {}) => ({
		data: {
			stripe_account_id: "acct_1",
			stripe_account_domains: ["acme.com"],
			account_checked_at: now,
			livemode: true,
			stripe_charges_enabled: true,
			stripe_business_name: "Acme Inc.",
			stripe_country: "US",
			stripe_business_url_host: "www.acme.com",
			...extra,
		},
	});

	it("states what Stripe says about the vendor's own account, and nothing about payments", async () => {
		await useDb({ vendor_stripe_credentials: cred(), vendors: noOverride });
		expect(await stripeBusiness("v1", "acme.com")).toEqual({
			verified: true,
			name: "Acme Inc.",
			country: "US",
			website: "www.acme.com",
			website_matches_domain: true,
			binding: "domain_match",
		});
	});

	it("is never verified on a test key or without charges enabled", async () => {
		await useDb({ vendor_stripe_credentials: cred({ livemode: false }), vendors: noOverride });
		expect((await stripeBusiness("v1", "acme.com"))?.verified).toBe(false);
		await useDb({ vendor_stripe_credentials: cred({ stripe_charges_enabled: false }), vendors: noOverride });
		expect((await stripeBusiness("v1", "acme.com"))?.verified).toBe(false);
	});

	it("is null for someone else's account or a read older than a day", async () => {
		await useDb({ vendor_stripe_credentials: cred({ stripe_account_domains: ["other.com"] }), vendors: noOverride });
		expect(await stripeBusiness("v1", "acme.com")).toBeNull();
		await useDb({ vendor_stripe_credentials: cred({ account_checked_at: "2020-01-01T00:00:00Z" }), vendors: noOverride });
		expect(await stripeBusiness("v1", "acme.com")).toBeNull();
	});
});

describe("stripeBusinessConfirms", () => {
	const base = { verified: true, name: "Acme", country: "US", website: "acme.com", website_matches_domain: true, binding: "domain_match" as const };
	it("needs Stripe's verification and the website on the domain, or a staff approval", () => {
		expect(stripeBusinessConfirms(base)).toBe(true);
		expect(stripeBusinessConfirms({ ...base, verified: false })).toBe(false);
		expect(stripeBusinessConfirms({ ...base, website_matches_domain: false })).toBe(false);
		expect(stripeBusinessConfirms({ ...base, website_matches_domain: false, binding: "staff_override" })).toBe(true);
		expect(stripeBusinessConfirms(null)).toBe(false);
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
