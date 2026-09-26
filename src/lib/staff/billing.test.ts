import { describe, expect, it, vi } from "vitest";
import { agenticReadBillingReport, currentBillingMonth } from "./billing";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

function mockDb(rows: { vendor_slug: string; read_count: number }[] | null, error: { message: string } | null = null) {
	const eq = vi.fn(async () => ({ data: rows, error }));
	const select = vi.fn(() => ({ eq }));
	return { from: vi.fn(() => ({ select })), eq, select };
}

describe("currentBillingMonth", () => {
	it("floors to the first of the UTC month", () => {
		expect(currentBillingMonth(new Date("2026-09-26T23:00:00Z"))).toBe("2026-09-01");
		expect(currentBillingMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
	});
});

describe("agenticReadBillingReport", () => {
	it("returns null (not an empty report) when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(agenticReadBillingReport()).resolves.toBeNull();
	});

	it("returns null and logs when the query errors", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb(null, { message: "boom" }) as never);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(agenticReadBillingReport()).resolves.toBeNull();
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("query failed"), "boom");
		consoleError.mockRestore();
	});

	it("prices every vendor's rolled-up count and sorts highest-charge first", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(
			mockDb([
				{ vendor_slug: "vantage", read_count: 10 }, // free
				{ vendor_slug: "acme", read_count: 1000 }, // $138.00
				{ vendor_slug: "lettertrace", read_count: 100 }, // $6.00
			]) as never
		);

		const now = new Date("2026-09-26T00:00:00Z");
		const report = await agenticReadBillingReport(now);

		expect(report).toEqual([
			{
				vendorSlug: "acme",
				billingMonth: "2026-09-01",
				charge: { totalReads: 1000, tier2Reads: 475, tier3Reads: 500, amountCents: 13_800 },
				amountFormatted: "$138.00",
			},
			{
				vendorSlug: "lettertrace",
				billingMonth: "2026-09-01",
				charge: { totalReads: 100, tier2Reads: 75, tier3Reads: 0, amountCents: 600 },
				amountFormatted: "$6.00",
			},
			{
				vendorSlug: "vantage",
				billingMonth: "2026-09-01",
				charge: { totalReads: 10, tier2Reads: 0, tier3Reads: 0, amountCents: 0 },
				amountFormatted: "$0.00",
			},
		]);
	});

	it("scopes the query to the given billing month", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb([]);
		vi.mocked(dbClient).mockReturnValue(db as never);

		await agenticReadBillingReport(new Date("2026-09-26T00:00:00Z"));

		expect(db.from).toHaveBeenCalledWith("agentic_read_rollups");
		expect(db.eq).toHaveBeenCalledWith("billing_month", "2026-09-01");
	});
});
