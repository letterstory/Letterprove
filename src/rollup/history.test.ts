import { describe, expect, it, vi } from "vitest";
import { loadPersistedChain } from "./history";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

function mockDb(result: { data: unknown; error: unknown }) {
	const range = vi.fn().mockResolvedValue(result);
	const order = vi.fn().mockReturnValue({ range });
	const eq2 = vi.fn().mockReturnValue({ order });
	const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
	const select = vi.fn().mockReturnValue({ eq: eq1 });
	const from = vi.fn().mockReturnValue({ select });
	return { from, select, eq1, eq2, order, range };
}

describe("loadPersistedChain", () => {
	it("returns an empty history without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(loadPersistedChain("vantage", "acme-corp")).resolves.toEqual([]);
	});

	it("maps rows oldest-first into hourBucket/attestation pairs", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rows = [
			{ hour_bucket: 100, attestation: { published_at: "a" } },
			{ hour_bucket: 101, attestation: { published_at: "b" } },
		];
		const db = mockDb({ data: rows, error: null });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const chain = await loadPersistedChain("vantage", "acme-corp");
		expect(chain).toEqual([
			{ hourBucket: 100, attestation: { published_at: "a" } },
			{ hourBucket: 101, attestation: { published_at: "b" } },
		]);
		expect(db.from).toHaveBeenCalledWith("published_snapshots");
		expect(db.eq1).toHaveBeenCalledWith("vendor_slug", "vantage");
		expect(db.eq2).toHaveBeenCalledWith("customer_slug", "acme-corp");
		expect(db.order).toHaveBeenCalledWith("hour_bucket", { ascending: true });
	});

	// Deliberately NOT an empty-array fallback. An empty history is a real
	// answer that sends the caller back to GENESIS_HASH; returning it after a
	// failed read would silently drop published history and republish a chain
	// that contradicts the one already served — indistinguishable from us
	// rewriting the record.
	it("throws rather than reporting an empty history when the query errors", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: null, error: { message: "boom" } }) as never);

		await expect(loadPersistedChain("vantage", "acme-corp")).rejects.toThrow(/cannot read published history/);
	});

	it("distinguishes a read failure from a customer that genuinely has no history", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: [], error: null }) as never);

		await expect(loadPersistedChain("vantage", "globex")).resolves.toEqual([]);
	});
});
