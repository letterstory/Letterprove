import { describe, expect, it, vi, beforeEach } from "vitest";
import { syncVendorStripe } from "./sync";
import { credentialFor } from "./credentials";
import { checkStripeAccount, recordAccount } from "./account";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/notify/vendor-email", () => ({ notifyVendor: vi.fn() }));
vi.mock("./credentials", () => ({ credentialFor: vi.fn() }));
vi.mock("./account", () => ({ checkStripeAccount: vi.fn(), recordAccount: vi.fn() }));

const ACCOUNT = { id: "acct_1", domains: ["acme-vendor.com"], charges_enabled: true, business_name: "Acme", country: "US", business_url_host: "acme-vendor.com" };

/** Records every delete and update; `failures` is what the credential row reads back. */
function mockDb(failures = 0) {
	const deletes: string[] = [];
	const updates: Record<string, unknown>[] = [];
	const db = {
		from(table: string) {
			return {
				select: () => ({
					eq: () => ({
						maybeSingle: () => Promise.resolve({ data: { consecutive_sync_failures: failures }, error: null }),
					}),
				}),
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
	return { db, deletes, updates };
}

async function useDb(failures = 0) {
	const m = mockDb(failures);
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(m.db as never);
	return m;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(credentialFor).mockResolvedValue({ key: "rk_live_x", livemode: true, productIds: [] });
});

describe("syncVendorStripe", () => {
	it("records the account and reports a verified business, reading no payments", async () => {
		const m = await useDb();
		vi.mocked(checkStripeAccount).mockResolvedValue({ ok: true, account: ACCOUNT, overridden: false });

		const r = await syncVendorStripe("v1");
		expect(r).toEqual({ ok: true, bound: true, chargesEnabled: true, testMode: false, truncated: false });
		expect(recordAccount).toHaveBeenCalledWith("v1", ACCOUNT);
		// Whatever the retired payment sync left behind is cleared.
		expect(m.deletes).toEqual(["vendor_payment_evidence", "vendor_payment_unmatched", "vendor_stripe_payers"]);
		expect(m.updates.at(-1)).toMatchObject({ table: "vendor_stripe_credentials", consecutive_sync_failures: 0 });
	});

	it("says a test key is test mode", async () => {
		await useDb();
		vi.mocked(credentialFor).mockResolvedValue({ key: "rk_test_x", livemode: false, productIds: [] });
		vi.mocked(checkStripeAccount).mockResolvedValue({ ok: true, account: ACCOUNT, overridden: false });
		expect(await syncVendorStripe("v1")).toMatchObject({ ok: true, testMode: true });
	});

	it("records and reports an account that isn't the vendor's, without failing", async () => {
		await useDb();
		vi.mocked(checkStripeAccount).mockResolvedValue({ ok: false, error: "stripe_account_domain_mismatch", detail: "not yours", account: ACCOUNT });
		const r = await syncVendorStripe("v1");
		expect(r).toMatchObject({ ok: true, bound: false, chargesEnabled: false, warning: "not yours" });
		expect(recordAccount).toHaveBeenCalled();
	});

	it("counts an unreadable account as a failure, and clears the recorded business at the third", async () => {
		vi.mocked(checkStripeAccount).mockResolvedValue({ ok: false, error: "stripe_account_unreadable", detail: "Stripe down" });
		const first = await useDb(0);
		expect(await syncVendorStripe("v1")).toEqual({ ok: false, error: "Stripe down" });
		expect(first.updates.some((u) => u.account_checked_at === null)).toBe(false);

		const third = await useDb(2);
		await syncVendorStripe("v1");
		expect(third.updates.some((u) => u.account_checked_at === null && u.stripe_charges_enabled === null)).toBe(true);
	});

	it("needs a connected key", async () => {
		await useDb();
		vi.mocked(credentialFor).mockResolvedValue(null);
		expect(await syncVendorStripe("v1")).toEqual({ ok: false, error: "No Stripe key connected." });
	});
});
