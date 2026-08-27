import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAggregateHistory } from "./aggregate-history";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

function mockDb(result: { data: unknown; error: unknown }) {
	const range = vi.fn().mockResolvedValue(result);
	const order = vi.fn().mockReturnValue({ range });
	const eq = vi.fn().mockReturnValue({ order });
	const select = vi.fn().mockReturnValue({ eq });
	return { from: vi.fn().mockReturnValue({ select }), select, eq, order, range };
}

beforeEach(() => vi.clearAllMocks());

describe("loadAggregateHistory", () => {
	it("returns an empty history without a datastore — nothing was ever frozen", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);
		await expect(loadAggregateHistory("lettertrace")).resolves.toEqual([]);
	});

	it("maps rows oldest-first", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({
			data: [
				{ hour_bucket: 100, attestation: { published_at: "a" } },
				{ hour_bucket: 101, attestation: { published_at: "b" } },
			],
			error: null,
		});
		vi.mocked(dbClient).mockReturnValue(db as never);

		await expect(loadAggregateHistory("lettertrace")).resolves.toEqual([
			{ hourBucket: 100, attestation: { published_at: "a" } },
			{ hourBucket: 101, attestation: { published_at: "b" } },
		]);
		expect(db.from).toHaveBeenCalledWith("published_aggregates");
		expect(db.order).toHaveBeenCalledWith("hour_bucket", { ascending: true });
	});

	// An empty array sends the caller back to GENESIS_HASH and republishes a
	// one-entry chain. After a transient error that would silently discard real
	// history, which reads to a verifier exactly like tampering.
	it("throws on a read failure rather than reporting no history", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: null, error: { message: "boom" } }) as never);
		await expect(loadAggregateHistory("lettertrace")).rejects.toThrow(/cannot read published aggregate history/);
	});

	it("distinguishes a real empty history from a failed read", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: [], error: null }) as never);
		await expect(loadAggregateHistory("new-vendor")).resolves.toEqual([]);
	});
});
