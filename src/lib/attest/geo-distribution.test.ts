import { describe, expect, it, vi } from "vitest";
import { geoDistribution } from "./geo-distribution";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * Mimics `.from().select().eq().gte().order().range()`, which is where the query
 * resolves now that the read pages (see src/lib/db/read-all.ts). One page comes
 * back, which readAllRows treats as the last; the cap itself is exercised
 * against real Postgres in paged-reads.schema.test.ts.
 */
function mockDb(result: { data?: unknown; error?: { message: string } }) {
	const chain = {
		select: () => chain,
		eq: () => chain,
		gte: () => chain,
		order: () => chain,
		range: () => Promise.resolve({ data: null, error: null, ...result }),
	};
	return { from: () => chain };
}

async function withRows(rows: { country: string | null; region: string | null }[]) {
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(mockDb({ data: rows }) as never);
	return geoDistribution("lettertrace");
}

describe("geoDistribution", () => {
	it("returns an empty shape when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		expect(await geoDistribution("lettertrace")).toEqual({
			regions: {},
			unknown: 0,
			distinctRegions: 0,
		});
	});

	it("counts events per country-region", async () => {
		const result = await withRows([
			{ country: "US", region: "CA" },
			{ country: "US", region: "CA" },
			{ country: "GB", region: "ENG" },
		]);

		expect(result.regions).toEqual({ "US-CA": 2, "GB-ENG": 1 });
		expect(result.distinctRegions).toBe(2);
	});

	it("keeps a country without a region separate rather than merging it", async () => {
		// Real production data: Vercel reports AU with no region at all. Folding
		// those into the country's other rows would overstate how concentrated
		// a vendor's traffic is, which is the number this feature is about.
		const result = await withRows([
			{ country: "AU", region: null },
			{ country: "AU", region: "NSW" },
		]);

		expect(result.regions).toEqual({ AU: 1, "AU-NSW": 1 });
		expect(result.distinctRegions).toBe(2);
	});

	it("counts location-less events separately instead of dropping them", async () => {
		// Every row predating geo capture has no location. Silently ignoring
		// them would make coverage look complete when it is not.
		const result = await withRows([
			{ country: "US", region: "NY" },
			{ country: null, region: null },
			{ country: null, region: null },
		]);

		expect(result.unknown).toBe(2);
		expect(result.regions).toEqual({ "US-NY": 1 });
	});

	it("orders regions descending so the same data always serialises identically", async () => {
		const result = await withRows([
			{ country: "GB", region: "ENG" },
			{ country: "US", region: "CA" },
			{ country: "US", region: "CA" },
			{ country: "US", region: "CA" },
		]);

		expect(Object.keys(result.regions)).toEqual(["US-CA", "GB-ENG"]);
	});

	it("breaks a count tie by key, so equal regions never reshuffle", async () => {
		const a = await withRows([
			{ country: "ZZ", region: "A" },
			{ country: "AA", region: "B" },
		]);
		const b = await withRows([
			{ country: "AA", region: "B" },
			{ country: "ZZ", region: "A" },
		]);

		expect(Object.keys(a.regions)).toEqual(Object.keys(b.regions));
	});

	it("fails to an empty shape rather than throwing when the query errors", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ error: { message: "boom" } }) as never);

		expect(await geoDistribution("lettertrace")).toEqual({
			regions: {},
			unknown: 0,
			distinctRegions: 0,
		});
	});

	it("handles a vendor with no events", async () => {
		expect(await withRows([])).toEqual({ regions: {}, unknown: 0, distinctRegions: 0 });
	});
});
