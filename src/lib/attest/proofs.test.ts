import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, snapshotHash } from "./verify";
import { jwks } from "./keys";
import { customerChain, customerProof, earned, vendorProof } from "./proofs";
import { verifyAttestation } from "./verify";
import type { SignedAttestation } from "./types";

vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));
vi.mock("@/rollup/history", () => ({ loadPersistedChain: vi.fn() }));

// Vendor/customer identity is DB-backed now (supabase/migrations/
// 20260814230000_vendor_accounts.sql), but this suite is exercising chain
// composition and consent gating, not the database — so mock the lookup at
// the module boundary, holding it to the same two vendors/customers the
// static fixture used to ship.
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

		// acme-corp's fixture asserts tier 2 / verified, and is the one customer
		// with consent to be named — so it's also the only one customerProof
		// will return at all.
		const proof = await customerProof("vantage", "acme-corp");
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
		expect(earned(tier2, true, true)).toEqual({ tier: 2, verified: true });
	});

	it("refuses every asserted tier when nothing was observed", () => {
		expect(earned(tier2, false, true)).toEqual({ tier: 0, verified: false });
		expect(earned(tier1, false, true)).toEqual({ tier: 0, verified: false });
	});

	// The ceiling half of the rule. Observation earns the asserted tier; it
	// never grants a higher one, however much traffic there is — tier 2 is
	// about what a fact is bound to, not how much of it there is.
	it("never raises a claim above what the vendor asserted", () => {
		expect(earned(tier1, true, true)).toEqual({ tier: 1, verified: false });
	});

	// The gate one step earlier: an observation only counts as evidence if we
	// know whose origin produced it. Origin binds a browser, not curl, so
	// without DNS control of the vendor's domain the traffic is the vendor
	// asserting — and asserting earns tier 0.
	it("refuses every tier while the vendor's domain is unverified, however much was observed", () => {
		expect(earned(tier2, true, false)).toEqual({ tier: 0, verified: false });
		expect(earned(tier1, true, false)).toEqual({ tier: 0, verified: false });
	});

	it("needs both verification and observation, not either", () => {
		expect(earned(tier2, false, false)).toEqual({ tier: 0, verified: false });
		expect(earned(tier2, true, true)).toEqual({ tier: 2, verified: true });
	});
});

describe("consent-gated publication", () => {
	beforeEach(async () => {
		const { currentSnapshot } = await import("@/rollup/snapshots");
		const { loadPersistedChain } = await import("@/rollup/history");
		vi.mocked(loadPersistedChain).mockReset().mockResolvedValue([]);
		vi.mocked(currentSnapshot).mockReset().mockResolvedValue({
			observed_through: "2026-08-20T00:00:00.000Z",
			published_at: "2026-08-20T00:00:00.000Z",
			sessions_30d: 100,
			seats_active: 0,
			observed: true,
			readOk: true,
		});
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	it("publishes an attestation for a customer who consented to be named", async () => {
		vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
		await expect(customerProof("vantage", "acme-corp")).resolves.not.toBeNull();
	});

	it("withholds one for a customer who has not, even though the chain exists", async () => {
		vi.setSystemTime(new Date("2026-08-20T01:00:00.000Z"));

		// northwind is attested and tier 2 — withheld for consent, not for lack
		// of evidence. The chain is still computed and still frozen; only
		// publication is gated, which is what makes flipping consent a no-op.
		await expect(customerProof("vantage", "northwind")).resolves.toBeNull();
		await expect(customerChain("vantage", "northwind")).resolves.toHaveLength(1);
	});

	it("treats a customer with no consent field as anonymous", async () => {
		vi.setSystemTime(new Date("2026-08-20T02:00:00.000Z"));

		// globex declares no consent at all. Opt-in means the absent case is
		// private — a customer added without thinking about consent must never
		// be published by default.
		await expect(customerProof("vantage", "globex")).resolves.toBeNull();
	});

	it("counts every attested customer in the aggregate but lists only the named", async () => {
		vi.setSystemTime(new Date("2026-08-20T03:00:00.000Z"));
		const proof = await vendorProof("vantage");

		// acme-corp + northwind are both attested; only acme-corp is named.
		expect(proof!.summary.attested_customers).toBe(2);
		expect(proof!.summary.attested_unnamed).toBe(1);
		expect(proof!.customers.map((c) => c.current.customer)).toEqual(["acme-corp"]);

		// The aggregate is the consent-safe view, so it stays complete: sla comes
		// only from northwind, who is never named anywhere on the page.
		expect(proof!.summary.features_proven).toContain("sla");
		expect(proof!.summary.sessions_30d).toBe(200);
	});

	it("never leaks a withheld customer's name through the vendor report", async () => {
		vi.setSystemTime(new Date("2026-08-20T04:00:00.000Z"));
		const proof = await vendorProof("vantage");

		expect(JSON.stringify(proof)).not.toContain("Northwind");
		expect(JSON.stringify(proof)).not.toContain("northwind");
	});
});
