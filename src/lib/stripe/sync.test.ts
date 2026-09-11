import { describe, expect, it, vi, beforeEach } from "vitest";
import { syncVendorPayments } from "./sync";
import { credentialFor } from "./credentials";
import { fetchPaidInvoices, fetchSubscriptions } from "./fetch";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("./credentials", () => ({ credentialFor: vi.fn() }));
vi.mock("./fetch", () => ({ fetchSubscriptions: vi.fn(), fetchPaidInvoices: vi.fn() }));

/**
 * Records every table touched and what was written to it. `vendorDomain`
 * backs the `.from("vendors").select("domain").eq(...).maybeSingle()` read
 * `syncVendorPayments` does before mapping payments — defaults to a domain
 * outside the Letter Company's own set, since these tests exercise ordinary
 * vendor payment mapping, not the self-dealing check.
 *
 * `failures` is the credential row's consecutive-failure count, which the
 * failure path reads back before deciding whether the evidence has stood
 * uncorroborated long enough to delete.
 */
function mockDb(observed: string[] = ["acme.com"], vendorDomain = "acme-vendor.com", failures = 0) {
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
						maybeSingle: () =>
							Promise.resolve({
								data: { domain: vendorDomain, consecutive_sync_failures: failures },
								error: null,
							}),
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

/**
 * Money that really settled for each subscription, recent enough to count.
 * Every success case needs it now: a subscription on its own is an intention
 * to bill, and map.ts scores what was collected.
 */
function paid(ids: string[]) {
	const recent = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
	return {
		ok: true as const,
		truncated: false,
		payments: new Map(
			ids.map((id) => [
				id,
				{ firstSettledAt: recent - 90 * 24 * 60 * 60, lastSettledAt: recent, settledCount: 4, markedPaidCount: 0 },
			])
		),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(fetchPaidInvoices).mockResolvedValue(paid(["sub_1"]));
});

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

	it("CLEARS evidence a previous live key left behind when a test key is connected", async () => {
		// The swap that would otherwise publish forever: connect live, sync,
		// then replace the key with a test one. The live path replaces evidence
		// wholesale on every sync and this branch never reaches it, so without
		// the clear the old account's evidence stands with nothing connected
		// that could ever contradict it.
		const { db, deletes, inserts } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_test_x", livemode: false });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "billing@acme.com")],
		});

		await syncVendorPayments("v1", "lettertrace");

		expect(deletes).toContain("vendor_payment_evidence");
		expect(deletes).toContain("vendor_payment_unmatched");
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

	it("reports truncation from the INVOICE read too, which shortens tenure", async () => {
		// A truncated invoice list understates `since` rather than inventing it,
		// but a signed document that quietly says "paying since 2026" about a
		// customer of five years is still wrong, and nothing downstream can tell
		// a prefix from the whole thing.
		const { db } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: true, truncated: false, subscriptions: [] });
		vi.mocked(fetchPaidInvoices).mockResolvedValue({ ...paid([]), truncated: true });

		expect(await syncVendorPayments("v1", "lettertrace")).toMatchObject({ truncated: true });
	});
});

describe("syncVendorPayments — corroboration by what settled, not by what was configured", () => {
	async function wire(db: unknown) {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "billing@acme.com")],
		});
	}

	it("stores nothing for an active subscription nothing ever settled against", async () => {
		// The forgery this closes. A $0 price, or a 100%-off coupon, reaches
		// `active` in Stripe for nothing at all, and used to publish as a
		// signed, verified tier-3 claim naming any company the vendor liked.
		const { db, inserts } = mockDb(["acme.com"]);
		await wire(db);
		vi.mocked(fetchPaidInvoices).mockResolvedValue(paid([]));

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result).toMatchObject({ ok: true, matched: 0, unmatched: 1 });
		expect(inserts["vendor_payment_evidence"]).toBeUndefined();
		expect(inserts["vendor_payment_unmatched"][0]).toMatchObject({ reason: "no_settled_invoice" });
	});

	it("dates evidence from the settled invoice, not from a backdatable start_date", async () => {
		const { db, inserts } = mockDb(["acme.com"]);
		await wire(db);

		await syncVendorPayments("v1", "lettertrace");

		const row = inserts["vendor_payment_evidence"][0] as { since: string };
		// sub() carries a fixed start_date in 2026; the settled invoice is 93
		// days old. A `since` older than that would mean start_date won, and
		// start_date is a field the account owner sets to whatever they like.
		expect(Date.now() - Date.parse(row.since)).toBeLessThan(200 * 24 * 60 * 60 * 1000);
	});

	it("fails the sync when the key cannot read invoices, naming the permission", async () => {
		// The alternative — falling back to subscriptions alone — would hand a
		// vendor the old forgeable behaviour back by removing one permission
		// from their own key.
		const { db, inserts, updates } = mockDb(["acme.com"]);
		await wire(db);
		vi.mocked(fetchPaidInvoices).mockResolvedValue({
			ok: false,
			status: 403,
			error: "The provided key does not have the required permissions.",
			scope: true,
		});

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toMatch(/read Invoices/i);
		expect(inserts["vendor_payment_evidence"]).toBeUndefined();
		expect(updates[0]).toMatchObject({ consecutive_sync_failures: 1 });
	});
});

describe("syncVendorPayments — a failed sync cannot freeze a favourable claim", () => {
	it("does NOT stamp last_synced_at on a failure", async () => {
		// It used to. The one column that could answer "how old is this
		// evidence?" reported "just now" every hour a revoked key failed.
		const { db, updates } = mockDb();
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: false, status: 401, error: "Expired API Key provided" });

		await syncVendorPayments("v1", "lettertrace");

		expect(updates[0]).not.toHaveProperty("last_synced_at");
		expect(updates[0]).toMatchObject({ consecutive_sync_failures: 1 });
	});

	it("leaves evidence standing for the first failures, so one blip is not a wipe", async () => {
		const { db, deletes } = mockDb(["acme.com"], "acme-vendor.com", 0);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: false, status: 500, error: "Stripe returned 500" });

		await syncVendorPayments("v1", "lettertrace");

		expect(deletes).not.toContain("vendor_payment_evidence");
	});

	it("DELETES evidence once failures pass the threshold", async () => {
		// A vendor who revokes their own key otherwise freezes the last
		// favourable answer in place: nothing can refresh it, and the only
		// consequence is an alert addressed to the person who revoked it.
		const { db, deletes } = mockDb(["acme.com"], "acme-vendor.com", 2);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: false, status: 401, error: "Expired API Key provided" });

		await syncVendorPayments("v1", "lettertrace");

		expect(deletes).toContain("vendor_payment_evidence");
		expect(deletes).toContain("vendor_payment_unmatched");
	});

	it("resets the failure run on a success", async () => {
		const { db, updates } = mockDb(["acme.com"], "acme-vendor.com", 2);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "billing@acme.com")],
		});

		await syncVendorPayments("v1", "lettertrace");

		expect(updates.at(-1)).toMatchObject({ consecutive_sync_failures: 0, last_sync_failed_at: null });
	});
});
