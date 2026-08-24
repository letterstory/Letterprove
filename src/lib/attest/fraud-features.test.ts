import { describe, expect, it, vi } from "vitest";
import { fraudFeatures } from "./fraud-features";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

// domainArrivals runs its own query against the same client. Stubbing it keeps
// these cases about the rollup maths they were written for, rather than about
// whether one mock can satisfy two different query shapes; the real behaviour
// has its own suite in domain-arrivals.test.ts.
vi.mock("./domain-arrivals", () => ({
	domainArrivals: vi.fn().mockResolvedValue({ vendor_first_seen: null, first_seen: [] }),
}));
vi.mock("./geo-distribution", () => ({
	geoDistribution: vi.fn().mockResolvedValue({ regions: {}, unknown: 0, distinctRegions: 0 }),
}));

/** Mimics the chainable `.from().select().eq().eq().gte().order()` shape the query uses. */
function mockDb(result: { data: unknown; error: unknown }) {
	const order = vi.fn().mockResolvedValue(result);
	const gte = vi.fn().mockReturnValue({ order });
	const eq2 = vi.fn().mockReturnValue({ gte });
	const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
	const select = vi.fn().mockReturnValue({ eq: eq1 });
	const from = vi.fn().mockReturnValue({ select });
	return { from, select, eq1, eq2, gte, order };
}

describe("fraudFeatures", () => {
	it("returns an all-zero window without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		const result = await fraudFeatures("vantage", "acme-corp", "acme-corp.example");
		expect(result.schema_version).toBe(1);
		expect(result.vendor).toBe("vantage");
		expect(result.customer).toBe("acme-corp");
		expect(result.events).toEqual({ sessions: 0, signups: 0, logins: 0 });
		expect(result.hourly_buckets).toEqual([]);
		expect(result.asn_distribution).toBeNull();
		expect(result.distinct_hash_counts).toBeNull();
	});

	it("sums events and builds one hourly bucket per rollup row, in order", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({
			data: [
				{ sessions: 10, signups: 1, logins: 2 },
				{ sessions: 12, signups: 0, logins: 3 },
				{ sessions: 8, signups: 2, logins: 1 },
			],
			error: null,
		});
		vi.mocked(dbClient).mockReturnValue(db as never);

		const result = await fraudFeatures("vantage", "acme-corp", "acme-corp.example");
		expect(result.events).toEqual({ sessions: 30, signups: 3, logins: 6 });
		expect(result.hourly_buckets).toEqual([13, 15, 11]);
		expect(db.from).toHaveBeenCalledWith("hot_rollups");
		expect(db.eq1).toHaveBeenCalledWith("vendor_slug", "vantage");
		expect(db.eq2).toHaveBeenCalledWith("domain", "acme-corp.example");
	});

	it("falls back to an all-zero window rather than throwing when the query errors", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: null, error: { message: "boom" } }) as never);

		const result = await fraudFeatures("vantage", "acme-corp", "acme-corp.example");
		expect(result.events).toEqual({ sessions: 0, signups: 0, logins: 0 });
		expect(result.hourly_buckets).toEqual([]);
	});

	it("returns empty buckets for a domain with no rolled-up rows", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: [], error: null }) as never);

		const result = await fraudFeatures("vantage", "globex", "globex.example");
		expect(result.events).toEqual({ sessions: 0, signups: 0, logins: 0 });
		expect(result.hourly_buckets).toEqual([]);
	});
});
