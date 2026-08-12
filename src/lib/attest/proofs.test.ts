import { beforeEach, describe, expect, it, vi } from "vitest";
import { jwks } from "./keys";
import { customerChain, customerProof } from "./proofs";
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
		});

		const proof = await customerProof("vantage", "acme-corp");
		expect(proof).not.toBeNull();
		expect(proof!.chain).toHaveLength(1);
		expect(proof!.current.sessions_30d).toBe(42);
		expect(proof!.current.seats_active).toBe(0);
		expect(verifyAttestation(proof!.current, jwks())).toEqual({ ok: true });
		expect(currentSnapshot).toHaveBeenCalledWith("vantage", "acme-corp.example");
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
		});

		const [a, b] = await Promise.all([customerChain("vantage", "northwind"), customerChain("vantage", "northwind")]);
		expect(a![0].signature).toBe(b![0].signature);
		expect(currentSnapshot).toHaveBeenCalledTimes(1);
	});
});
