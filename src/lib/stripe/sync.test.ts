import { describe, expect, it, vi, beforeEach } from "vitest";
import { syncVendorPayments } from "./sync";
import { credentialFor } from "./credentials";
import { fetchSubscriptions } from "./fetch";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("./credentials", () => ({ credentialFor: vi.fn() }));
vi.mock("./fetch", () => ({ fetchSubscriptions: vi.fn() }));

/**
 * Records every table touched and what was written to it. `vendorDomain`
 * backs the `.from("vendors").select("domain").eq(...).maybeSingle()` read
 * `syncVendorPayments` does before mapping payments — defaults to a domain
 * outside the Letter Company's own set, since these tests exercise ordinary
 * vendor payment mapping, not the self-dealing check.
 */
function mockDb(observed: string[] = ["acme.com"], vendorDomain = "acme-vendor.com") {
	const inserts: Record<string, unknown[]> = {};
	const deletes: string[] = [];
	const updates: Record<string, unknown>[] = [];

	const db = {
		from(table: string) {
			return {
				select: () => ({
					eq: () => ({
						// Paged now: .gte().order().order().range(). One page is returned,
						// which readAllRows treats as the last — read-all.test.ts covers
						// the multi-page case where it can actually be exercised.
						gte: () => {
							const page = {
								order: () => page,
								range: () =>
									Promise.resolve({ data: observed.map((domain) => ({ domain })), error: null }),
							};
							return page;
						},
						maybeSingle: () => Promise.resolve({ data: { domain: vendorDomain }, error: null }),
					}),
				}),
				insert: (rows: unknown[]) => {
					inserts[table] = (inserts[table] ?? []).concat(rows);
					return Promise.resolve({ error: null });
				},
				delete: () => ({
					eq: () => {
						deletes.push(table);
						return Promise.resolve({ error: null });
					},
				}),
				update: (patch: Record<string, unknown>) => ({
					eq: () => {
						updates.push({ table, ...patch });
						return Promise.resolve({ error: null });
					},
				}),
			};
		},
	};
	return { db, inserts, deletes, updates };
}

function sub(id: string, email: string | null, amount = 400000) {
	return {
		id,
		status: "active",
		start_date: 1_770_000_000,
		currency: "usd",
		amount,
		interval: "month" as const,
		customerEmail: email,
	};
}

beforeEach(() => vi.clearAllMocks());

describe("syncVendorPayments", () => {
	it("refuses without a connected credential", async () => {
		const { db } = mockDb();
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue(null);

		expect(await syncVendorPayments("v1", "lettertrace")).toEqual({
			ok: false,
			error: "No Stripe key connected.",
		});
	});

	it("stores evidence for a domain that both pays AND was observed", async () => {
		const { db, inserts } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "billing@acme.com")],
		});

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result).toMatchObject({ ok: true, matched: 1, unmatched: 0, testMode: false });
		expect(inserts["vendor_payment_evidence"]).toHaveLength(1);
		expect(inserts["vendor_payment_evidence"][0]).toMatchObject({
			domain: "acme.com",
			monthly_amount: 400000,
		});
	});

	it("stores NOTHING as evidence for a test-mode key, but still reports the counts", async () => {
		// Test payments are invented by definition. A tier-3 claim built from
		// them is the exact false corroboration this tier exists to rule out —
		// but the vendor still needs to see their wiring works.
		const { db, inserts } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_test_x", livemode: false });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "billing@acme.com")],
		});

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result).toMatchObject({ ok: true, matched: 1, testMode: true });
		expect(inserts["vendor_payment_evidence"]).toBeUndefined();
	});

	it("does NOT publish payment for a company that was never observed", async () => {
		// Payment alone is evidence about billing. Tier 3 is the join.
		const { db, inserts } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "ap@never-seen.com")],
		});

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result).toMatchObject({ matched: 0, unmatched: 1 });
		expect(inserts["vendor_payment_evidence"]).toBeUndefined();
		expect(inserts["vendor_payment_unmatched"][0]).toMatchObject({ reason: "no_observed_traffic" });
	});

	it("stores nothing when telemetry cannot be read, rather than everything", async () => {
		// An empty observed set must fail closed. mapPayments defaults that way
		// and this never passes allowUnobserved.
		const { db, inserts } = mockDb([]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "billing@acme.com")],
		});

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result).toMatchObject({ matched: 0 });
		expect(inserts["vendor_payment_evidence"]).toBeUndefined();
	});

	it("replaces evidence rather than merging, so a cancellation disappears", async () => {
		// The failure this prevents: a stale row asserting a customer still pays
		// after they stopped, inside a signed claim.
		const { db, deletes } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: true, truncated: false, subscriptions: [] });

		await syncVendorPayments("v1", "lettertrace");

		expect(deletes).toContain("vendor_payment_evidence");
		expect(deletes).toContain("vendor_payment_unmatched");
	});

	it("records Stripe's error on the credential so a vendor can be told why", async () => {
		const { db, updates } = mockDb();
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: false,
			status: 401,
			error: "Expired API Key provided",
		});

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result).toEqual({ ok: false, error: "Expired API Key provided" });
		expect(updates[0]).toMatchObject({ last_sync_error: "Expired API Key provided" });
	});

	it("clears a previous error on a successful sync", async () => {
		const { db, updates } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "billing@acme.com")],
		});

		await syncVendorPayments("v1", "lettertrace");

		expect(updates.at(-1)).toMatchObject({ last_sync_error: null });
	});

	it("passes truncation through so a partial read is visible", async () => {
		const { db } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: true, truncated: true, subscriptions: [] });

		expect(await syncVendorPayments("v1", "lettertrace")).toMatchObject({ truncated: true });
	});
});
