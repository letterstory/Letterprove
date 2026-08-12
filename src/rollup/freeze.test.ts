import { describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, snapshotHash } from "@/lib/attest/verify";
import { freezeSnapshots } from "./freeze";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));

function mockDb({ selectResult, upsertResult }: { selectResult: { data: unknown; error: unknown }; upsertResult: { error: unknown } }) {
	const chain = {} as {
		select: ReturnType<typeof vi.fn>;
		eq: ReturnType<typeof vi.fn>;
		lt: ReturnType<typeof vi.fn>;
		order: ReturnType<typeof vi.fn>;
		limit: ReturnType<typeof vi.fn>;
		maybeSingle: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	chain.select = vi.fn(() => chain);
	chain.eq = vi.fn(() => chain);
	chain.lt = vi.fn(() => chain);
	chain.order = vi.fn(() => chain);
	chain.limit = vi.fn(() => chain);
	chain.maybeSingle = vi.fn().mockResolvedValue(selectResult);
	chain.upsert = vi.fn().mockResolvedValue(upsertResult);
	const from = vi.fn(() => chain);
	return { from, ...chain };
}

describe("freezeSnapshots", () => {
	it("reports failure without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(freezeSnapshots()).resolves.toEqual({ ok: false, frozen: 0, detail: "no datastore configured" });
	});

	it("freezes every fixture customer, chaining onto genesis when no prior row exists", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T22:00:00.000Z",
			published_at: "2026-08-12T22:00:00.000Z",
			sessions_30d: 5,
			seats_active: 0,
		});
		const db = mockDb({ selectResult: { data: null, error: null }, upsertResult: { error: null } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const result = await freezeSnapshots();
		expect(result).toEqual({ ok: true, frozen: 3 });

		const upsertCalls = db.upsert.mock.calls;
		expect(upsertCalls).toHaveLength(3);
		const [row, opts] = upsertCalls[0] as [Record<string, unknown>, Record<string, unknown>];
		expect((row.attestation as { prev_hash: string }).prev_hash).toBe(GENESIS_HASH);
		expect(opts).toEqual({ onConflict: "vendor_slug,customer_slug,hour_bucket" });
	});

	it("chains onto the previous hour's persisted hash rather than genesis", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T22:00:00.000Z",
			published_at: "2026-08-12T22:00:00.000Z",
			sessions_30d: 5,
			seats_active: 0,
		});
		const priorAttestation = { published_at: "2026-08-12T21:00:00.000Z", sessions_30d: 4 };
		const expectedPrevHash = snapshotHash(priorAttestation as never);
		const db = mockDb({
			selectResult: { data: { attestation: priorAttestation }, error: null },
			upsertResult: { error: null },
		});
		vi.mocked(dbClient).mockReturnValue(db as never);

		const result = await freezeSnapshots();
		expect(result.ok).toBe(true);

		const [row] = (db.upsert.mock.calls[0] as [Record<string, unknown>]) ?? [];
		expect((row.attestation as { prev_hash: string }).prev_hash).toBe(expectedPrevHash);
	});

	it("surfaces a select error rather than throwing", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const db = mockDb({ selectResult: { data: null, error: { message: "select boom" } }, upsertResult: { error: null } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		await expect(freezeSnapshots()).resolves.toEqual({ ok: false, frozen: 0, detail: "select boom" });
	});

	it("surfaces an upsert error rather than throwing", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T22:00:00.000Z",
			published_at: "2026-08-12T22:00:00.000Z",
			sessions_30d: 5,
			seats_active: 0,
		});
		const db = mockDb({ selectResult: { data: null, error: null }, upsertResult: { error: { message: "upsert boom" } } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		await expect(freezeSnapshots()).resolves.toEqual({ ok: false, frozen: 0, detail: "upsert boom" });
	});
});
