import { describe, expect, it, vi, beforeEach } from "vitest";
import { syncVendorPayments } from "./sync";
import { credentialFor } from "./credentials";
import { fetchPaidInvoices, fetchSubscriptions } from "./fetch";
import { checkStripeAccount } from "./account";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("./credentials", () => ({ credentialFor: vi.fn() }));
vi.mock("./fetch", () => ({ fetchSubscriptions: vi.fn(), fetchPaidInvoices: vi.fn() }));
vi.mock("./account", () => ({ checkStripeAccount: vi.fn(), recordAccount: vi.fn() }));

const ACCOUNT = { id: "acct_1", domains: ["acme-vendor.com"] };

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

/** The billing email and amount each test's subscriptions settled with, keyed by subscription id. */
const billed = new Map<string, { email: string | null; amount: number }>();

/**
 * A subscription, and — registered alongside it — what its settled invoices
 * carry. The billed identity and the amount live on the invoices now, frozen
 * when each one settled, so a test's "who pays" travels to paid() through here.
 */
function sub(id: string, email: string | null, amount = 400000) {
	billed.set(id, { email, amount });
	return {
		id,
		status: "active",
		start_date: 1_770_000_000,
		currency: "usd",
		interval: "month" as const,
		productIds: ["prod_core"],
	};
}

/**
 * Money that really settled for each subscription, recent enough to count.
 * Every success case needs it now: a subscription on its own is an intention
 * to bill, and map.ts scores what was collected.
 */
function paid(ids: string[]) {
	const recent = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
	const invoice = (id: string, paidAt: number) => {
		const { email, amount } = billed.get(id) ?? { email: "billing@acme.com", amount: 400000 };
		return {
			id: `in_${id}_${paidAt}`,
			paidAt,
			amountPaid: amount,
			currency: "usd",
			customerEmail: email,
			billingReason: "subscription_cycle",
			lines: [{ product: "prod_core", net: amount }],
			linesComplete: true,
		};
	};
	return {
		ok: true as const,
		truncated: false,
		payments: new Map(
			ids.map((id) => [id, { settled: [invoice(id, recent - 90 * 24 * 60 * 60), invoice(id, recent)], markedPaidCount: 0 }]),
		),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	billed.clear();
	// Built at call time, so it sees the billing each test registered via sub().
	vi.mocked(fetchPaidInvoices).mockImplementation(async () => paid(["sub_1"]));
	vi.mocked(checkStripeAccount).mockResolvedValue({ ok: true, account: ACCOUNT, overridden: false });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_test_x", livemode: false, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_test_x", livemode: false, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: true, truncated: false, subscriptions: [] });

		await syncVendorPayments("v1", "lettertrace");

		expect(deletes).toContain("vendor_payment_evidence");
		expect(deletes).toContain("vendor_payment_unmatched");
	});

	it("records Stripe's error on the credential so a vendor can be told why", async () => {
		const { db, updates } = mockDb();
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: true, truncated: false, subscriptions: [] });
		vi.mocked(fetchPaidInvoices).mockResolvedValue({ ...paid([]), truncated: true });

		expect(await syncVendorPayments("v1", "lettertrace")).toMatchObject({ truncated: true });
	});
});

describe("syncVendorPayments — corroboration by what settled, not by what was configured", () => {
	async function wire(db: unknown) {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
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

	it("does NOT fail, and does not page, when the same key is TEST mode", async () => {
		// The regression this pins, found in production the day after the tier-3
		// change shipped. That change put a required invoice read in front of the
		// test-mode branch, whose whole purpose is letting a vendor confirm their
		// wiring before they have anything to prove. The first test key connected
		// paged the alert channel every hour for thirteen hours about a permission
		// that could not have changed one stored row, because a test key writes no
		// evidence whatever it is able to read.
		//
		// It is still a real thing the vendor must fix before a live key works, so
		// it travels back as a warning they can see rather than an alert nobody
		// can act on.
		const { db, inserts, updates } = mockDb(["acme.com"]);
		await wire(db);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_test_x", livemode: false, productIds: [] });
		vi.mocked(fetchPaidInvoices).mockResolvedValue({
			ok: false,
			status: 403,
			error: "The provided key does not have the required permissions.",
			scope: true,
		});

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result.ok).toBe(true);
		expect(result.ok === true && result.testMode).toBe(true);
		expect(result.ok === true && result.scopeWarning).toMatch(/read Invoices/i);
		// Still stores nothing, and still does not count as a failure.
		expect(inserts["vendor_payment_evidence"]).toBeUndefined();
		expect(updates.some((u) => "consecutive_sync_failures" in (u as object) && (u as { consecutive_sync_failures?: number }).consecutive_sync_failures)).toBe(false);
	});
});

describe("syncVendorPayments — a failed sync cannot freeze a favourable claim", () => {
	it("does NOT stamp last_synced_at on a failure", async () => {
		// It used to. The one column that could answer "how old is this
		// evidence?" reported "just now" every hour a revoked key failed.
		const { db, updates } = mockDb();
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: false, status: 401, error: "Expired API Key provided" });

		await syncVendorPayments("v1", "lettertrace");

		expect(updates[0]).not.toHaveProperty("last_synced_at");
		expect(updates[0]).toMatchObject({ consecutive_sync_failures: 1 });
	});

	it("leaves evidence standing for the first failures, so one blip is not a wipe", async () => {
		const { db, deletes } = mockDb(["acme.com"], "acme-vendor.com", 0);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
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
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: false, status: 401, error: "Expired API Key provided" });

		await syncVendorPayments("v1", "lettertrace");

		expect(deletes).toContain("vendor_payment_evidence");
		expect(deletes).toContain("vendor_payment_unmatched");
	});

	it("resets the failure run on a success", async () => {
		const { db, updates } = mockDb(["acme.com"], "acme-vendor.com", 2);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			truncated: false,
			subscriptions: [sub("sub_1", "billing@acme.com")],
		});

		await syncVendorPayments("v1", "lettertrace");

		expect(updates.at(-1)).toMatchObject({ consecutive_sync_failures: 0, last_sync_failed_at: null });
	});
});

describe("syncVendorPayments — the account and the scope", () => {
	const MISMATCH = {
		ok: false as const,
		error: "stripe_account_domain_mismatch" as const,
		detail: "This Stripe account (acct_2) describes itself as other.com, not acme-vendor.com",
		account: { id: "acct_2", domains: ["other.com"] },
	};

	it("clears evidence at once, and fails, when a live key belongs to someone else's account", async () => {
		// Not a transient failure counted toward the threshold: a ledger that
		// is not the vendor's corroborates none of their customers, from now.
		const { db, deletes, updates } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
		vi.mocked(checkStripeAccount).mockResolvedValue(MISMATCH);

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result).toEqual({ ok: false, error: MISMATCH.detail });
		expect(deletes).toContain("vendor_payment_evidence");
		expect(fetchSubscriptions).not.toHaveBeenCalled();
		expect(updates.some((u) => u.last_sync_error === MISMATCH.detail)).toBe(true);
	});

	it("warns rather than fails for a test key with an account problem", async () => {
		const { db } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_test_x", livemode: false, productIds: [] });
		vi.mocked(checkStripeAccount).mockResolvedValue(MISMATCH);

		expect(await syncVendorPayments("v1", "lettertrace")).toMatchObject({ ok: true, testMode: true, scopeWarning: MISMATCH.detail });
	});

	it("counts an unreachable account read as an ordinary failure, without clearing early", async () => {
		const { db, deletes } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
		vi.mocked(checkStripeAccount).mockResolvedValue({ ok: false, error: "stripe_account_unreadable", detail: "Couldn't reach Stripe." });

		expect(await syncVendorPayments("v1", "lettertrace")).toEqual({ ok: false, error: "Couldn't reach Stripe." });
		expect(deletes).not.toContain("vendor_payment_evidence");
	});

	it("applies the vendor's product scope", async () => {
		const { db, inserts } = mockDb(["acme.com"]);
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(db as never);
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: ["prod_elsewhere"] });
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: true, truncated: false, subscriptions: [sub("sub_1", "billing@acme.com")] });

		const result = await syncVendorPayments("v1", "lettertrace");

		expect(result).toMatchObject({ ok: true, matched: 0, unmatched: 1 });
		expect(inserts["vendor_payment_evidence"]).toBeUndefined();
		expect(inserts["vendor_payment_unmatched"]).toEqual([expect.objectContaining({ reason: "out_of_scope" })]);
	});
});
