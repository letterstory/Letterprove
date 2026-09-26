import { describe, expect, it, vi } from "vitest";
import { agenticReadBillingReport, currentBillingMonth, previousBillingMonth } from "./billing";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

function mockDb(opts: {
	rollupRows: { vendor_slug: string; read_count: number }[] | null;
	rollupError?: { message: string } | null;
	vendorRows?: { slug: string; letterstory_org_id: string | null }[] | null;
	vendorError?: { message: string } | null;
}) {
	const rollupEq = vi.fn(async () => ({ data: opts.rollupRows, error: opts.rollupError ?? null }));
	const rollupSelect = vi.fn(() => ({ eq: rollupEq }));
	const vendorIn = vi.fn(async () => ({ data: opts.vendorRows ?? [], error: opts.vendorError ?? null }));
	const vendorSelect = vi.fn(() => ({ in: vendorIn }));

	const from = vi.fn((table: string) => {
		if (table === "agentic_read_rollups") return { select: rollupSelect };
		if (table === "vendors") return { select: vendorSelect };
		throw new Error(`unexpected table: ${table}`);
	});
	return { from, rollupEq, rollupSelect, vendorIn, vendorSelect };
}

describe("currentBillingMonth", () => {
	it("floors to the first of the UTC month", () => {
		expect(currentBillingMonth(new Date("2026-09-26T23:00:00Z"))).toBe("2026-09-01");
		expect(currentBillingMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
	});
});

describe("previousBillingMonth", () => {
	it("floors to the first of the PRIOR UTC month", () => {
		expect(previousBillingMonth(new Date("2026-09-26T23:00:00Z"))).toBe("2026-08-01");
	});

	it("rolls back across a year boundary", () => {
		expect(previousBillingMonth(new Date("2026-01-15T00:00:00Z"))).toBe("2025-12-01");
	});
});

describe("agenticReadBillingReport", () => {
	it("returns null (not an empty report) when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(agenticReadBillingReport()).resolves.toBeNull();
	});

	it("returns null and logs when the rollup query errors", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ rollupRows: null, rollupError: { message: "boom" } }) as never);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(agenticReadBillingReport()).resolves.toBeNull();
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("query failed"), "boom");
		consoleError.mockRestore();
	});

	it("returns [] without querying vendors when nobody read anything that month", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({ rollupRows: [] });
		vi.mocked(dbClient).mockReturnValue(db as never);

		await expect(agenticReadBillingReport({ billingMonth: "2026-09-01" })).resolves.toEqual([]);
		expect(db.vendorSelect).not.toHaveBeenCalled();
	});

	it("returns null and logs when the vendor org lookup errors", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(
			mockDb({
				rollupRows: [{ vendor_slug: "acme", read_count: 100 }],
				vendorError: { message: "boom" },
			}) as never
		);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(agenticReadBillingReport({ billingMonth: "2026-09-01" })).resolves.toBeNull();
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("org lookup failed"), "boom");
		consoleError.mockRestore();
	});

	it("prices every vendor's rolled-up count, joins its org id, and sorts highest-charge first", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(
			mockDb({
				rollupRows: [
					{ vendor_slug: "vantage", read_count: 10 }, // free
					{ vendor_slug: "acme", read_count: 1000 }, // $138.00
					{ vendor_slug: "lettertrace", read_count: 100 }, // $6.00
				],
				vendorRows: [
					{ slug: "acme", letterstory_org_id: "org-acme" },
					{ slug: "lettertrace", letterstory_org_id: "org-lettertrace" },
					{ slug: "vantage", letterstory_org_id: null },
				],
			}) as never
		);

		const report = await agenticReadBillingReport({ billingMonth: "2026-09-01" });

		expect(report).toEqual([
			{
				vendorSlug: "acme",
				letterstoryOrgId: "org-acme",
				billingMonth: "2026-09-01",
				charge: { totalReads: 1000, tier2Reads: 475, tier3Reads: 500, amountCents: 13_800 },
				amountFormatted: "$138.00",
			},
			{
				vendorSlug: "lettertrace",
				letterstoryOrgId: "org-lettertrace",
				billingMonth: "2026-09-01",
				charge: { totalReads: 100, tier2Reads: 75, tier3Reads: 0, amountCents: 600 },
				amountFormatted: "$6.00",
			},
			{
				vendorSlug: "vantage",
				letterstoryOrgId: null,
				billingMonth: "2026-09-01",
				charge: { totalReads: 10, tier2Reads: 0, tier3Reads: 0, amountCents: 0 },
				amountFormatted: "$0.00",
			},
		]);
	});

	it("treats a vendor missing from the org lookup the same as an unlinked one", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(
			mockDb({
				rollupRows: [{ vendor_slug: "orphaned", read_count: 30 }],
				vendorRows: [],
			}) as never
		);

		const report = await agenticReadBillingReport({ billingMonth: "2026-09-01" });
		expect(report?.[0]).toMatchObject({ vendorSlug: "orphaned", letterstoryOrgId: null });
	});

	it("defaults to the previous calendar month when no billingMonth is given", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({ rollupRows: [] });
		vi.mocked(dbClient).mockReturnValue(db as never);

		await agenticReadBillingReport({ now: new Date("2026-09-26T00:00:00Z") });

		expect(db.from).toHaveBeenCalledWith("agentic_read_rollups");
		expect(db.rollupEq).toHaveBeenCalledWith("billing_month", "2026-08-01");
	});

	it("uses an explicit billingMonth over the now-derived default", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({ rollupRows: [] });
		vi.mocked(dbClient).mockReturnValue(db as never);

		await agenticReadBillingReport({ billingMonth: "2025-01-01", now: new Date("2026-09-26T00:00:00Z") });

		expect(db.rollupEq).toHaveBeenCalledWith("billing_month", "2025-01-01");
	});
});
