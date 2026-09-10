import { beforeEach, describe, expect, it, vi } from "vitest";
import { freezeAggregates } from "./freeze-aggregates";
import { isDemonstration } from "@/lib/attest/keys";
import { GENESIS_HASH, snapshotHash } from "@/lib/attest/verify";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/attest/aggregate", () => ({ signAggregate: vi.fn() }));
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/fixtures/vendors")>()),
	allVendors: vi.fn(),
}));
// Only isDemonstration is stubbed; the rest of keys.ts stays real. Unstubbed,
// every test would hit the dev-key refusal, since a test process has neither
// the countersign RPC nor a configured local key.
vi.mock("@/lib/attest/keys", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/attest/keys")>()),
	isDemonstration: vi.fn(),
}));

function mockDb(opts: { last?: unknown; lastError?: string; upsertError?: string }) {
	const maybeSingle = vi.fn().mockResolvedValue(
		opts.lastError ? { data: null, error: { message: opts.lastError } } : { data: opts.last ?? null, error: null }
	);
	const upsert = vi.fn().mockResolvedValue({
		error: opts.upsertError ? { message: opts.upsertError } : null,
	});
	const chain = { maybeSingle, limit: () => chain, order: () => chain, lt: () => chain, eq: () => chain, select: () => chain };
	return { from: vi.fn(() => ({ ...chain, upsert })), upsert, maybeSingle };
}

async function setup(db: unknown, signed: unknown = { published_at: "2026-08-18T00:00:00Z", vendor: "lettertrace" }) {
	const { dbClient } = await import("@/lib/db/client");
	const { allVendors } = await import("@/lib/fixtures/vendors");
	const { signAggregate } = await import("@/lib/attest/aggregate");
	vi.mocked(isDemonstration).mockReturnValue(false);
	vi.mocked(allVendors).mockResolvedValue([{ slug: "lettertrace", customers: [] }] as never);
	vi.mocked(signAggregate).mockResolvedValue(signed as never);
	vi.mocked(dbClient).mockReturnValue(db as never);
}

beforeEach(() => vi.clearAllMocks());

describe("freezeAggregates", () => {
	// The guard that would have prevented the 2026-08-13 incident, applied to
	// the aggregate: frozen rows are immutable, so a dev-key signature stays in
	// the chain and fails verification forever once the JWKS drops that key.
	it("refuses to write development-key signatures into immutable history", async () => {
		const db = mockDb({});
		await setup(db);
		vi.mocked(isDemonstration).mockReturnValue(true);

		const r = await freezeAggregates();
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/development-key/);
		expect(db.upsert).not.toHaveBeenCalled();
	});

	it("reports failure without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(isDemonstration).mockReturnValue(false);
		vi.mocked(dbClient).mockReturnValue(null);
		await expect(freezeAggregates()).resolves.toMatchObject({ ok: false, frozen: 0 });
	});

	it("chains onto genesis when nothing has been frozen yet", async () => {
		const db = mockDb({ last: null });
		await setup(db);

		const { signAggregate } = await import("@/lib/attest/aggregate");
		await freezeAggregates();
		expect(signAggregate).toHaveBeenCalledWith("lettertrace", GENESIS_HASH);
	});

	// prevHash must come from an EARLIER hour, never the row being overwritten,
	// or a rerun chains an hour onto its own previous version.
	it("chains onto the previous hour's stored attestation", async () => {
		const prior = { vendor: "lettertrace", kind: "aggregate", published_at: "x", signature: "s", key_id: "k" };
		await setup(mockDb({ last: { attestation: prior } }));

		const { signAggregate } = await import("@/lib/attest/aggregate");
		await freezeAggregates();
		expect(signAggregate).toHaveBeenCalledWith("lettertrace", snapshotHash(prior));
	});

	// aggregateBody returns null for an unreadable telemetry read. A signed
	// "0 companies observed" would be a wrong claim, not a missing one.
	it("skips a vendor whose aggregate could not be built", async () => {
		const db = mockDb({});
		await setup(db, null);

		const r = await freezeAggregates();
		expect(r).toMatchObject({ ok: true, frozen: 0, skipped: ["lettertrace"] });
		expect(db.upsert).not.toHaveBeenCalled();
	});

	it("surfaces a read error rather than throwing", async () => {
		await setup(mockDb({ lastError: "select boom" }));
		// Scoped to the vendor, so the alert built from it names the blast radius.
		await expect(freezeAggregates()).resolves.toMatchObject({ ok: false, detail: "lettertrace: select boom" });
	});

	it("surfaces an upsert error rather than throwing", async () => {
		await setup(mockDb({ upsertError: "upsert boom" }));
		await expect(freezeAggregates()).resolves.toMatchObject({ ok: false, detail: "lettertrace: upsert boom" });
	});

	it("freezes the signed document whole, not just its numbers", async () => {
		const signed = { vendor: "lettertrace", kind: "aggregate", companies_observed: 24, published_at: "2026-08-18T00:00:00Z", signature: "sig" };
		const db = mockDb({});
		await setup(db, signed);

		await freezeAggregates();
		const row = db.upsert.mock.calls[0][0] as { attestation: unknown; hour_bucket: number };
		// The signature covers the whole body; storing fields would let a later
		// change to how the body is built alter what was already served.
		expect(row.attestation).toEqual(signed);
		expect(typeof row.hour_bucket).toBe("number");
	});
});
