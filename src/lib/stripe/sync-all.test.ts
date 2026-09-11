import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("./sync", () => ({ syncVendorPayments: vi.fn() }));

import { dbClient } from "@/lib/db/client";
import { syncVendorPayments } from "./sync";
import { syncAllVendorPayments } from "./sync-all";

/**
 * Two paged reads and nothing else: the credential table, then the vendor
 * table. Both resolve at `.range()`, because that is where readAllRows
 * finishes and a mock that resolved earlier would prove nothing about the
 * caller paging correctly.
 */
function mockDb(
	credentials: string[],
	vendors: { id: string; slug: string }[],
	options: { credentialError?: string; vendorError?: string } = {},
) {
	const db = {
		from(table: string) {
			const builder = {
				select: () => builder,
				order: () => builder,
				range: async (from: number, to: number) => {
					if (table === "vendor_stripe_credentials") {
						if (options.credentialError) return { data: null, error: { message: options.credentialError } };
						return { data: credentials.slice(from, to + 1).map((vendor_id) => ({ vendor_id })), error: null };
					}
					if (options.vendorError) return { data: null, error: { message: options.vendorError } };
					return { data: vendors.slice(from, to + 1), error: null };
				},
			};
			return builder;
		},
	};
	vi.mocked(dbClient).mockReturnValue(db as never);
}

const ACME = { id: "11111111-1111-1111-1111-111111111111", slug: "acme" };
const GLOBEX = { id: "22222222-2222-2222-2222-222222222222", slug: "globex" };

function synced(over: Record<string, unknown> = {}) {
	return { ok: true as const, matched: 2, unmatched: 0, testMode: false, truncated: false, ...over };
}

describe("syncAllVendorPayments", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("syncs only the vendors that have a credential", async () => {
		mockDb([ACME.id], [ACME, GLOBEX]);
		vi.mocked(syncVendorPayments).mockResolvedValue(synced());

		const result = await syncAllVendorPayments();

		expect(result).toMatchObject({ ok: true, attempted: 1, synced: 1, testMode: 0, failures: [] });
		expect(syncVendorPayments).toHaveBeenCalledTimes(1);
		expect(syncVendorPayments).toHaveBeenCalledWith(ACME.id, ACME.slug);
	});

	it("does nothing at all when no vendor has connected Stripe", async () => {
		mockDb([], [ACME]);

		expect(await syncAllVendorPayments()).toMatchObject({ ok: true, attempted: 0 });
		expect(syncVendorPayments).not.toHaveBeenCalled();
	});

	// The explicit instruction in the brief, and the one a naive implementation
	// gets wrong: a test key stores nothing BY DESIGN. Counting that as a
	// failure would page hourly about the product working as specified.
	it("counts a test-mode sync as a success and not a failure", async () => {
		mockDb([ACME.id], [ACME]);
		vi.mocked(syncVendorPayments).mockResolvedValue(synced({ testMode: true, matched: 3 }));

		const result = await syncAllVendorPayments();

		expect(result).toMatchObject({ ok: true, attempted: 1, synced: 0, testMode: 1, failures: [] });
	});

	// Independent results, the freeze cron's pattern: one dead credential must
	// not cost every vendor behind it their sync.
	it("keeps syncing after a vendor fails, and names the one that failed", async () => {
		mockDb([ACME.id, GLOBEX.id], [ACME, GLOBEX]);
		vi.mocked(syncVendorPayments)
			.mockResolvedValueOnce({ ok: false, error: "Expired API Key provided." })
			.mockResolvedValueOnce(synced());

		const result = await syncAllVendorPayments();

		expect(result.ok).toBe(false);
		expect(result.synced).toBe(1);
		expect(result.failures).toEqual([{ vendorSlug: "acme", detail: "Expired API Key provided." }]);
	});

	it("turns a throwing sync into that vendor's failure rather than an escaped exception", async () => {
		mockDb([ACME.id, GLOBEX.id], [ACME, GLOBEX]);
		vi.mocked(syncVendorPayments)
			.mockRejectedValueOnce(new Error("socket hang up"))
			.mockResolvedValueOnce(synced());

		const result = await syncAllVendorPayments();

		expect(result.synced).toBe(1);
		expect(result.failures[0]).toMatchObject({ vendorSlug: "acme" });
		expect(result.failures[0].detail).toContain("socket hang up");
	});

	it("reports a truncated subscription list without calling the sync a failure", async () => {
		mockDb([ACME.id], [ACME]);
		vi.mocked(syncVendorPayments).mockResolvedValue(synced({ truncated: true }));

		const result = await syncAllVendorPayments();

		expect(result.ok).toBe(true);
		expect(result.truncated).toEqual(["acme"]);
	});

	// A failed enumeration is not a vendor's fault and must not be reported as
	// one: nothing was synced, and naming a vendor would send an investigation
	// to the wrong place.
	it("reports a run-level failure when the credential list cannot be read", async () => {
		mockDb([ACME.id], [ACME], { credentialError: "connection reset" });

		const result = await syncAllVendorPayments();

		expect(result.ok).toBe(false);
		expect(result.failures).toEqual([]);
		expect(result.detail).toContain("connection reset");
		expect(syncVendorPayments).not.toHaveBeenCalled();
	});

	it("reports a run-level failure when the vendor list cannot be read", async () => {
		mockDb([ACME.id], [ACME], { vendorError: "statement timeout" });

		expect(await syncAllVendorPayments()).toMatchObject({ ok: false, detail: expect.stringContaining("statement timeout") });
	});

	it("refuses to run with no datastore rather than reporting a clean sweep", async () => {
		vi.mocked(dbClient).mockReturnValue(null);

		expect(await syncAllVendorPayments()).toMatchObject({ ok: false, detail: "no datastore configured" });
	});

	// Impossible today: the credential table's foreign key cascades on delete.
	// Recorded per row rather than thrown, so the day it stops being impossible
	// is a named failure and not every vendor losing their sync.
	it("reports an orphaned credential without abandoning the other vendors", async () => {
		mockDb(["33333333-3333-3333-3333-333333333333", ACME.id], [ACME]);
		vi.mocked(syncVendorPayments).mockResolvedValue(synced());

		const result = await syncAllVendorPayments();

		expect(result.attempted).toBe(2);
		expect(result.synced).toBe(1);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].detail).toContain("no longer exists");
	});
});
