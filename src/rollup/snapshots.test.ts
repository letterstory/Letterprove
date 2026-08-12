import { describe, expect, it, vi } from "vitest";
import { currentSnapshot } from "./snapshots";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/** Mimics the chainable `.from().select().eq().eq().gte()` shape the query uses. */
function mockDb(result: { data: unknown; error: unknown }) {
	const gte = vi.fn().mockResolvedValue(result);
	const eq2 = vi.fn().mockReturnValue({ gte });
	const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
	const select = vi.fn().mockReturnValue({ eq: eq1 });
	const from = vi.fn().mockReturnValue({ select });
	return { from, gte, eq1, eq2, select };
}

describe("currentSnapshot", () => {
	it("returns a zeroed snapshot without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		const snapshot = await currentSnapshot("vantage", "acme-corp.example");
		expect(snapshot.sessions_30d).toBe(0);
		expect(snapshot.seats_active).toBe(0);
	});

	it("sums sessions across matching hot_rollups rows", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({ data: [{ sessions: 3 }, { sessions: 5 }, { sessions: 2 }], error: null });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const snapshot = await currentSnapshot("vantage", "acme-corp.example");
		expect(snapshot.sessions_30d).toBe(10);
		expect(snapshot.seats_active).toBe(0);
		expect(db.from).toHaveBeenCalledWith("hot_rollups");
		expect(db.eq1).toHaveBeenCalledWith("vendor_slug", "vantage");
		expect(db.eq2).toHaveBeenCalledWith("domain", "acme-corp.example");
	});

	it("returns 0 sessions for a domain with no rolled-up rows, without treating it as an error", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: [], error: null }) as never);

		const snapshot = await currentSnapshot("vantage", "globex.example");
		expect(snapshot.sessions_30d).toBe(0);
	});

	it("falls back to 0 rather than throwing when the query errors", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: null, error: { message: "boom" } }) as never);

		const snapshot = await currentSnapshot("vantage", "acme-corp.example");
		expect(snapshot.sessions_30d).toBe(0);
	});
});
