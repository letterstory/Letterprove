import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, snapshotHash } from "./verify";
import { jwks } from "./keys";
import { customerChain, customerProof } from "./proofs";
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

	it("caches the composed chain across repeated calls instead of re-querying every time", async () => {
		vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-03T00:00:00.000Z",
			published_at: "2026-08-03T00:00:00.000Z",
			sessions_30d: 7,
			seats_active: 0,
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
