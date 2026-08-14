import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, snapshotHash } from "./verify";
import { jwks } from "./keys";
import { customerChain, customerProof, earned } from "./proofs";
import { verifyAttestation } from "./verify";
import type { SignedAttestation } from "./types";

vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));
vi.mock("@/rollup/history", () => ({ loadPersistedChain: vi.fn() }));

const TTL_SECONDS = 3600;
function currentHourBucket(): number {
	return Math.floor(Date.now() / (TTL_SECONDS * 1000));
}

// `customerChain` caches by vendor/customer/hour in a module-level Map that
// is never reset between tests in this file. Each test pins the clock to
// its own hour (via fake timers) rather than needing a fresh fixture slug,
// so reusing a real customer slug across tests never hits another test's
// cached entry.

describe("customerProof", () => {
	beforeEach(async () => {
		const { currentSnapshot } = await import("@/rollup/snapshots");
		const { loadPersistedChain } = await import("@/rollup/history");
		vi.mocked(currentSnapshot).mockReset();
		vi.mocked(loadPersistedChain).mockReset().mockResolvedValue([]);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("signs a valid single-entry chain from the live snapshot, chained onto genesis", async () => {
		vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-01T00:00:00.000Z",
			published_at: "2026-08-01T00:00:00.000Z",
			sessions_30d: 42,
			seats_active: 0,
			observed: true,
			readOk: true,
		});

		const proof = await customerProof("vantage", "acme-corp");
		expect(proof).not.toBeNull();
		expect(proof!.chain).toHaveLength(1);
		expect(proof!.current.sessions_30d).toBe(42);
		expect(proof!.current.seats_active).toBe(0);
		expect(proof!.current.prev_hash).toBe(GENESIS_HASH);
		expect(verifyAttestation(proof!.current, jwks())).toEqual({ ok: true });
		expect(currentSnapshot).toHaveBeenCalledWith("vantage", "acme-corp.example");
	});

	it("returns null for an unknown customer without querying telemetry or persistence", async () => {
		vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
		const { currentSnapshot } = await import("@/rollup/snapshots");
		const { loadPersistedChain } = await import("@/rollup/history");

		const proof = await customerProof("vantage", "does-not-exist");
		expect(proof).toBeNull();
		expect(currentSnapshot).not.toHaveBeenCalled();
		expect(loadPersistedChain).not.toHaveBeenCalled();
	});

	// One end-to-end proof that the gate reaches the signed body — including
	// through the persisted path, since a frozen row is signed via the same
	// attestationBody() this live path uses. The rule itself is covered
	// exhaustively against `earned` below, where no cache is involved.
	it("drops an asserted claim to vendor-asserted tier 0 when nothing was observed", async () => {
		vi.setSystemTime(new Date("2026-08-12T21:00:00.000Z"));
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T21:00:00.000Z",
			published_at: "2026-08-12T21:00:00.000Z",
			sessions_30d: 0,
			seats_active: 0,
			observed: false,
			readOk: true,
		});

		// globex's fixture asserts tier 1.
		const proof = await customerProof("vantage", "globex");
		expect(proof!.current.tier).toBe(0);
		expect(proof!.current.verified).toBe(false);
		// Still a well-formed, signed document — a weaker claim, not a broken one.
		expect(verifyAttestation(proof!.current, jwks())).toEqual({ ok: true });
	});

	it("caches the composed chain across repeated calls instead of re-querying every time", async () => {
		vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-03T00:00:00.000Z",
			published_at: "2026-08-03T00:00:00.000Z",
			sessions_30d: 7,
			seats_active: 0,
			observed: true,
			readOk: true,
		});

		const [a, b] = await Promise.all([customerChain("vantage", "northwind"), customerChain("vantage", "northwind")]);
		expect(a![0].signature).toBe(b![0].signature);
		expect(currentSnapshot).toHaveBeenCalledTimes(1);
	});

	it("appends a fresh, unpersisted entry chained onto persisted history for an unfrozen hour", async () => {
		vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
		const { currentSnapshot } = await import("@/rollup/snapshots");
		const { loadPersistedChain } = await import("@/rollup/history");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-04T00:00:00.000Z",
			published_at: "2026-08-04T00:00:00.000Z",
			sessions_30d: 9,
			seats_active: 0,
			observed: true,
			readOk: true,
		});
		const priorAttestation = { published_at: "2026-08-03T23:00:00.000Z", sessions_30d: 4 } as unknown as SignedAttestation;
		vi.mocked(loadPersistedChain).mockResolvedValue([{ hourBucket: currentHourBucket() - 1, attestation: priorAttestation }]);

		const chain = await customerChain("vantage", "globex");
		expect(chain).toHaveLength(2);
		expect(chain![0]).toBe(priorAttestation);
		expect(chain![1].prev_hash).toBe(snapshotHash(priorAttestation));
		expect(chain![1].sessions_30d).toBe(9);
		expect(verifyAttestation(chain![1], jwks())).toEqual({ ok: true });
	});

	it("returns exactly the persisted chain, without appending or querying telemetry, once the current hour is already frozen", async () => {
		vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
		const { currentSnapshot } = await import("@/rollup/snapshots");
		const { loadPersistedChain } = await import("@/rollup/history");
		const priorAttestation = { published_at: "2026-08-04T23:00:00.000Z", sessions_30d: 3 } as unknown as SignedAttestation;
		const frozenNow = { published_at: "2026-08-05T00:00:00.000Z", sessions_30d: 11 } as unknown as SignedAttestation;
		vi.mocked(loadPersistedChain).mockResolvedValue([
			{ hourBucket: currentHourBucket() - 1, attestation: priorAttestation },
			{ hourBucket: currentHourBucket(), attestation: frozenNow },
		]);

		const chain = await customerChain("vantage", "acme-corp");
		expect(chain).toEqual([priorAttestation, frozenNow]);
		expect(currentSnapshot).not.toHaveBeenCalled();
	});
});

describe("earned", () => {
	const asserted = { slug: "x", name: "X", domain: "x.example", since: "2023-01", features: [] };
	const tier2 = { ...asserted, tier: 2 as const, verified: true };
	const tier1 = { ...asserted, tier: 1 as const, verified: false };

	it("publishes the asserted tier once something has been observed", () => {
		expect(earned(tier2, true)).toEqual({ tier: 2, verified: true });
	});

	it("refuses every asserted tier when nothing was observed", () => {
		expect(earned(tier2, false)).toEqual({ tier: 0, verified: false });
		expect(earned(tier1, false)).toEqual({ tier: 0, verified: false });
	});

	// The ceiling half of the rule. Observation earns the asserted tier; it
	// never grants a higher one, however much traffic there is — tier 2 is
	// about what a fact is bound to, not how much of it there is.
	it("never raises a claim above what the vendor asserted", () => {
		expect(earned(tier1, true)).toEqual({ tier: 1, verified: false });
	});
});
