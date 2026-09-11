import { describe, expect, it, vi } from "vitest";
import { currentSnapshot } from "./snapshots";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * Mimics the chainable `.from().select().eq().eq().gte().order().range()` shape
 * the query uses. It resolves at `.range()` because the read pages now (see
 * src/lib/db/read-all.ts): a signed `sessions_30d` must not be summed over
 * whatever prefix PostgREST felt like returning. One page comes back, which
 * readAllRows treats as the last; the real boundary is covered against Postgres
 * in src/lib/attest/paged-reads.schema.test.ts.
 */
function mockDb(result: { data: unknown; error: unknown }) {
	const range = vi.fn().mockResolvedValue(result);
	const order: ReturnType<typeof vi.fn> = vi.fn(() => ({ order, range }));
	const gte = vi.fn().mockReturnValue({ order, range });
	const eq2 = vi.fn().mockReturnValue({ gte });
	const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
	const select = vi.fn().mockReturnValue({ eq: eq1 });
	const from = vi.fn().mockReturnValue({ select });
	return { from, gte, eq1, eq2, select, order, range };
}

describe("currentSnapshot", () => {
	it("returns a zeroed snapshot without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		const snapshot = await currentSnapshot("vantage", "acme-corp.example");
		expect(snapshot.sessions_30d).toBe(0);
		expect(snapshot.seats_active).toBe(0);
		expect(snapshot.observed).toBe(false);
	});

	it("sums sessions across matching hot_rollups rows", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({ data: [{ sessions: 3 }, { sessions: 5 }, { sessions: 2 }], error: null });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const snapshot = await currentSnapshot("vantage", "acme-corp.example");
		expect(snapshot.sessions_30d).toBe(10);
		expect(snapshot.seats_active).toBe(0);
		expect(snapshot.observed).toBe(true);
		expect(db.from).toHaveBeenCalledWith("hot_rollups");
		expect(db.eq1).toHaveBeenCalledWith("vendor_slug", "vantage");
		expect(db.eq2).toHaveBeenCalledWith("domain", "acme-corp.example");
	});

	it("returns 0 sessions for a domain with no rolled-up rows, without treating it as an error", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: [], error: null }) as never);

		const snapshot = await currentSnapshot("vantage", "globex.example");
		expect(snapshot.sessions_30d).toBe(0);
		expect(snapshot.observed).toBe(false);
	});

	it("falls back to 0 rather than throwing when the query errors", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: null, error: { message: "boom" } }) as never);

		const snapshot = await currentSnapshot("vantage", "acme-corp.example");
		expect(snapshot.sessions_30d).toBe(0);
		expect(snapshot.observed).toBe(false);
	});

	// The distinction the whole evidence gate rests on. A customer whose rollup
	// rows exist but sum to zero HAS been observed; one with no rows has not.
	// Both report sessions_30d: 0, so nothing downstream can tell them apart
	// without this flag.
	it("separates a measured zero from the absence of a measurement", async () => {
		const { dbClient } = await import("@/lib/db/client");

		vi.mocked(dbClient).mockReturnValue(mockDb({ data: [{ sessions: 0 }], error: null }) as never);
		const measured = await currentSnapshot("vantage", "acme-corp.example");

		vi.mocked(dbClient).mockReturnValue(mockDb({ data: [], error: null }) as never);
		const unmeasured = await currentSnapshot("vantage", "acme-corp.example");

		expect(measured.sessions_30d).toBe(unmeasured.sessions_30d);
		expect(measured.observed).toBe(true);
		expect(unmeasured.observed).toBe(false);
	});
});
