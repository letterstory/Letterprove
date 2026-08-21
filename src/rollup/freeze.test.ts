import { beforeEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, snapshotHash } from "@/lib/attest/verify";
import { isDemonstration } from "@/lib/attest/keys";
import { freezeSnapshots } from "./freeze";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));

// allVendors() now reads through the same dbClient mocked above, but this
// suite's mockDb() below stubs the query chain freeze.ts itself issues
// (`published_snapshots`), not the `vendors`/`vendor_customers` reads
// vendors.ts makes. Mock the vendor identity lookup at the module boundary
// instead, holding it to the same two vendors/customers the static fixture
// used to ship, so the rest of this suite's assertions stay unchanged.
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/fixtures/vendors")>();
	const VENDORS: import("@/lib/fixtures/vendors").VendorFixture[] = [
		{
			slug: "vantage",
			name: "Vantage",
			domain: "vantage.example",
			category: "customer data platforms",
			key: "lp_live_vantage_9f2c", domainVerified: true,
			customers: [
				{ slug: "acme-corp", name: "Acme Corp", domain: "acme-corp.example", since: "2023-03", tier: 2, verified: true, features: ["sso", "api", "analytics"], consent: "named" },
				{ slug: "northwind", name: "Northwind", domain: "northwind.example", since: "2024-08", tier: 2, verified: true, features: ["sso", "api", "analytics", "sla"], consent: "anonymous" },
				{ slug: "globex", name: "Globex", domain: "globex.example", since: "2022-11", tier: 1, verified: false, features: ["sso", "audit_log", "api"] },
			],
		},
		{ slug: "lettertrace", name: "Lettertrace", domain: "lettertrace.com", category: "AI brand monitoring", key: "lp_live_lettertrace_5747b5e0f521", domainVerified: true, customers: [] },
	];
	return {
		...original,
		allVendors: async () => VENDORS,
		findVendor: async (slug: string) => VENDORS.find((v) => v.slug === slug),
		findVendorByKey: async (key: string) => VENDORS.find((v) => v.key === key),
	};
});

// Only `isDemonstration` is stubbed — the rest of keys.ts stays real so
// signAttestation still produces genuine signatures here. Unstubbed, the whole
// suite would hit the dev-key guard, since a test process has neither the
// countersign RPC nor a configured local key.
vi.mock("@/lib/attest/keys", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/attest/keys")>()),
	isDemonstration: vi.fn(),
}));

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
	beforeEach(() => {
		vi.mocked(isDemonstration).mockReturnValue(false);
	});

	// The guard that would have prevented the 2026-08-13 incident: four hours
	// of dev-key-signed rows were frozen into the chain and became permanently
	// unverifiable the moment the production JWKS stopped publishing that key.
	it("refuses to write development-key signatures into immutable history", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(isDemonstration).mockReturnValue(true);
		const db = mockDb({ selectResult: { data: null, error: null }, upsertResult: { error: null } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const result = await freezeSnapshots();
		expect(result.ok).toBe(false);
		expect(result.frozen).toBe(0);
		expect(result.detail).toMatch(/development-key/);
		expect(db.upsert).not.toHaveBeenCalled();
	});

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
			observed: true,
			readOk: true,
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
			observed: true,
			readOk: true,
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
			observed: true,
			readOk: true,
		});
		const db = mockDb({ selectResult: { data: null, error: null }, upsertResult: { error: { message: "upsert boom" } } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		await expect(freezeSnapshots()).resolves.toEqual({ ok: false, frozen: 0, detail: "upsert boom" });
	});

	// A failed telemetry read yields a body identical to a genuine tier-0.
	// Freezing it would record a permanent downgrade for a customer that may
	// have been healthy, and an immutable row cannot be corrected afterwards.
	it("skips a customer whose telemetry read failed rather than freezing a degraded claim", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T22:00:00.000Z",
			published_at: "2026-08-12T22:00:00.000Z",
			sessions_30d: 0,
			seats_active: 0,
			observed: false,
			readOk: false,
		});
		const db = mockDb({ selectResult: { data: null, error: null }, upsertResult: { error: null } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const result = await freezeSnapshots();
		expect(result.ok).toBe(true);
		expect(result.frozen).toBe(0);
		expect(result.skipped).toEqual(["vantage/acme-corp", "vantage/northwind", "vantage/globex"]);
		expect(db.upsert).not.toHaveBeenCalled();
	});

	// The distinction the skip rests on: a clean read of an empty table is a
	// real measurement and must still be frozen, or a customer with genuinely
	// no traffic would never get a chain entry at all.
	it("still freezes a clean read that simply found nothing", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T22:00:00.000Z",
			published_at: "2026-08-12T22:00:00.000Z",
			sessions_30d: 0,
			seats_active: 0,
			observed: false,
			readOk: true,
		});
		const db = mockDb({ selectResult: { data: null, error: null }, upsertResult: { error: null } });
		vi.mocked(dbClient).mockReturnValue(db as never);

		const result = await freezeSnapshots();
		expect(result).toEqual({ ok: true, frozen: 3 });
		const [row] = (db.upsert.mock.calls[0] as [Record<string, unknown>]) ?? [];
		expect((row.attestation as { tier: number }).tier).toBe(0);
	});
});
