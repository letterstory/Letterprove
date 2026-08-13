import { beforeEach, describe, expect, it, vi } from "vitest";
import { jwks } from "./keys";
import { customerChain, customerProof, earned } from "./proofs";
import { verifyAttestation } from "./verify";

vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));

// Each test uses a distinct customer slug: `customerChain` caches by
// vendor/customer/hour, and all tests in this file run inside the same
// hour bucket, so reusing a slug would silently hit another test's cache
// instead of exercising the mock.

describe("customerProof", () => {
	beforeEach(async () => {
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockReset();
	});

	it("signs a valid single-entry chain from the live snapshot", async () => {
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T21:00:00.000Z",
			published_at: "2026-08-12T21:00:00.000Z",
			sessions_30d: 42,
			seats_active: 0,
			observed: true,
		});

		const proof = await customerProof("vantage", "acme-corp");
		expect(proof).not.toBeNull();
		expect(proof!.chain).toHaveLength(1);
		expect(proof!.current.sessions_30d).toBe(42);
		expect(proof!.current.seats_active).toBe(0);
		expect(verifyAttestation(proof!.current, jwks())).toEqual({ ok: true });
		expect(currentSnapshot).toHaveBeenCalledWith("vantage", "acme-corp.example");
	});

	// One end-to-end proof that the gate reaches the signed body. The slug
	// budget is tight — the fixture has three customers and the cache note
	// above means one test each — so the rule itself is covered exhaustively
	// against `earned` below, where no cache is involved.
	it("drops an asserted claim to vendor-asserted tier 0 when nothing was observed", async () => {
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T21:00:00.000Z",
			published_at: "2026-08-12T21:00:00.000Z",
			sessions_30d: 0,
			seats_active: 0,
			observed: false,
		});

		// globex's fixture asserts tier 1.
		const proof = await customerProof("vantage", "globex");
		expect(proof!.current.tier).toBe(0);
		expect(proof!.current.verified).toBe(false);
		// Still a well-formed, signed document — a weaker claim, not a broken one.
		expect(verifyAttestation(proof!.current, jwks())).toEqual({ ok: true });
	});

	it("returns null for an unknown customer without querying telemetry", async () => {
		const { currentSnapshot } = await import("@/rollup/snapshots");

		const proof = await customerProof("vantage", "does-not-exist");
		expect(proof).toBeNull();
		expect(currentSnapshot).not.toHaveBeenCalled();
	});

	it("caches the chain across repeated calls instead of re-querying every time", async () => {
		const { currentSnapshot } = await import("@/rollup/snapshots");
		vi.mocked(currentSnapshot).mockResolvedValue({
			observed_through: "2026-08-12T21:00:00.000Z",
			published_at: "2026-08-12T21:00:00.000Z",
			sessions_30d: 7,
			seats_active: 0,
			observed: true,
		});

		const [a, b] = await Promise.all([customerChain("vantage", "northwind"), customerChain("vantage", "northwind")]);
		expect(a![0].signature).toBe(b![0].signature);
		expect(currentSnapshot).toHaveBeenCalledTimes(1);
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
