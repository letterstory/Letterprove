import { beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateBody, vendorAggregate, vendorAggregateChain } from "./aggregate";
import { jwks } from "./keys";
import { snapshotHash, verifyAttestation } from "./verify";
import type { SignedAttestation } from "./types";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
// Reached transitively via countersign -> fraudFeatures. It runs its own query
// shape against the same client, which the mock below is not built for, and
// none of these cases are about arrival timing. Real coverage lives in
// domain-arrivals.test.ts.
vi.mock("./domain-arrivals", () => ({
	domainArrivals: vi.fn().mockResolvedValue({ vendor_first_seen: null, first_seen: [] }),
}));
vi.mock("./geo-distribution", () => ({
	geoDistribution: vi.fn().mockResolvedValue({ regions: {}, unknown: 0, distinctRegions: 0 }),
}));
vi.mock("@/rollup/aggregate-history", () => ({ loadAggregateHistory: vi.fn() }));
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/fixtures/vendors")>()),
	findVendor: vi.fn(),
}));

/**
 * Two different chains hit this mock: the aggregate awaits `.gte()` directly,
 * while fraud-features calls `.gte().order()`. So `gte` returns a promise that
 * also carries `.order`, satisfying both without branching on the caller.
 */
function mockDb(result: { data: unknown; error: unknown }) {
	const settled = Object.assign(Promise.resolve(result), {
		order: vi.fn().mockResolvedValue(result),
	});
	const gte = vi.fn().mockReturnValue(settled);
	const eq: ReturnType<typeof vi.fn> = vi.fn(() => ({ gte, eq }));
	const select = vi.fn().mockReturnValue({ eq });
	return { from: vi.fn().mockReturnValue({ select }) };
}

function row(domain: string, sessions: number, signups = 0, logins = 0) {
	return { domain, sessions, signups, logins };
}

async function withRollups(rows: unknown[]) {
	const { dbClient } = await import("@/lib/db/client");
	const { findVendor } = await import("@/lib/fixtures/vendors");
	const { loadAggregateHistory } = await import("@/rollup/aggregate-history");
	// No frozen history by default, so the chain is one live entry from genesis.
	vi.mocked(loadAggregateHistory).mockResolvedValue([]);
	vi.mocked(findVendor).mockResolvedValue({
		slug: "lettertrace",
		name: "Lettertrace",
		domain: "lettertrace.com",
		category: "x",
		key: "k",
		customers: [],
	} as never);
	vi.mocked(dbClient).mockReturnValue(mockDb({ data: rows, error: null }) as never);
}

beforeEach(() => vi.clearAllMocks());

describe("aggregateBody", () => {
	// The claim exists so a vendor can publish something real before any
	// customer has agreed to be named.
	it("counts companies and sums their events", async () => {
		await withRollups([row("tenevents.com", 3, 1), row("juvare.com", 2), row("o3world.com", 1, 0, 4)]);

		const b = (await aggregateBody("lettertrace"))!;
		expect(b.companies_observed).toBe(3);
		expect(b.sessions).toBe(6);
		expect(b.signups).toBe(1);
		expect(b.logins).toBe(4);
		expect(b.domains_excluded).toBe(0);
		expect(b.tier).toBe(2);
	});

	// Free-mail is a person and our own domains are us. Counting either as a
	// company would inflate the one number the whole claim rests on.
	it("excludes unattributable domains from the count AND the totals", async () => {
		await withRollups([
			row("tenevents.com", 2),
			row("gmail.com", 50),
			row("lettertrace.com", 40),
			row("probe.invalid", 5),
		]);

		const b = (await aggregateBody("lettertrace"))!;
		expect(b.companies_observed).toBe(1);
		expect(b.domains_excluded).toBe(3);
		// 95 excluded sessions must not reach the headline.
		expect(b.sessions).toBe(2);
	});

	// Published rather than dropped: an agent seeing "1 company" next to 4
	// observed domains can tell the difference between filtering and
	// under-counting.
	it("publishes how many domains were set aside", async () => {
		await withRollups([row("gmail.com", 1), row("acme.com", 1)]);
		expect((await aggregateBody("lettertrace"))!.domains_excluded).toBe(1);
	});

	it("caps the tier at 0 when nothing attributable was observed", async () => {
		await withRollups([row("gmail.com", 99)]);

		const b = (await aggregateBody("lettertrace"))!;
		expect(b.companies_observed).toBe(0);
		expect(b.tier).toBe(0);
	});

	// A failed read must never publish as "0 companies observed" — a signed
	// zero is a claim, and a wrong one.
	it("returns null when telemetry cannot be read, rather than claiming zero", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { findVendor } = await import("@/lib/fixtures/vendors");
		vi.mocked(findVendor).mockResolvedValue({ slug: "lettertrace", customers: [] } as never);
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: null, error: { message: "boom" } }) as never);

		expect(await aggregateBody("lettertrace")).toBeNull();
	});

	it("returns null for an unknown vendor", async () => {
		const { findVendor } = await import("@/lib/fixtures/vendors");
		vi.mocked(findVendor).mockResolvedValue(undefined as never);
		expect(await aggregateBody("nope")).toBeNull();
	});

	// "Companies observed" is what the evidence supports. "Customers" is a
	// commercial fact we do not hold, and the gap between those two sentences
	// is the reason this product exists.
	it("never uses the word customer in the published body", async () => {
		await withRollups([row("acme.com", 1)]);
		expect(JSON.stringify(await aggregateBody("lettertrace"))).not.toMatch(/customer/i);
	});
});

describe("vendorAggregate", () => {
	it("signs a verifiable document", async () => {
		await withRollups([row("acme.com", 5)]);

		const signed = (await vendorAggregate("lettertrace"))!;
		expect(signed.kind).toBe("aggregate");
		expect(signed.key_id).toBeTruthy();
		// Verified with the same routine an outside agent uses on any other
		// attestation — the aggregate is not a second, weaker format.
		expect(verifyAttestation(signed as unknown as SignedAttestation, jwks())).toEqual({ ok: true });
	});

	it("serves the same bytes for the same hour, so page and JSON cannot disagree", async () => {
		await withRollups([row("acme.com", 5)]);
		const [a, b] = await Promise.all([vendorAggregate("lettertrace"), vendorAggregate("lettertrace")]);
		expect(a!.signature).toBe(b!.signature);
	});
});

// vendorAggregateChain memoises per vendor/hour in a module-level Map that is
// never reset, so each test uses its own slug. findVendor is mocked to answer
// for any slug, so the argument only has to be unique — same footgun the
// customer chain tests hit.
describe("vendorAggregateChain", () => {
	// The whole point of persisting: a chain that can be walked. Without frozen
	// rows every request republished a lone entry from genesis, so there was
	// nothing to audit — signed, but not auditable.
	it("appends a live entry onto frozen history, linked by prev_hash", async () => {
		await withRollups([row("acme.com", 5)]);
		const { loadAggregateHistory } = await import("@/rollup/aggregate-history");
		const frozen = {
			vendor: "lettertrace", kind: "aggregate", companies_observed: 9,
			published_at: "2026-08-18T00:00:00.000Z", signature: "s", key_id: "k",
		};
		vi.mocked(loadAggregateHistory).mockResolvedValue([{ hourBucket: 1, attestation: frozen as never }]);

		const chain = (await vendorAggregateChain("chain-append"))!;
		expect(chain).toHaveLength(2);
		expect(chain[0]).toBe(frozen);
		// The live entry commits to its predecessor, which is what makes a
		// rewrite of the earlier one detectable.
		expect(chain[1].prev_hash).toBe(snapshotHash(frozen));
	});

	it("serves exactly the frozen chain once this hour is already frozen", async () => {
		await withRollups([row("acme.com", 5)]);
		const { loadAggregateHistory } = await import("@/rollup/aggregate-history");
		const { aggregateBody } = await import("./aggregate");
		const nowBucket = Math.floor(Date.now() / 3_600_000);
		const frozenNow = { vendor: "lettertrace", kind: "aggregate", published_at: "x" };
		vi.mocked(loadAggregateHistory).mockResolvedValue([
			{ hourBucket: nowBucket, attestation: frozenNow as never },
		]);
		vi.mocked(aggregateBody).mockClear?.();

		const chain = (await vendorAggregateChain("chain-frozen"))!;
		expect(chain).toEqual([frozenNow]);
	});

	// A failed history read must not republish a one-entry chain from genesis —
	// an agent that fetched before and after would see history vanish, which is
	// indistinguishable from us rewriting the record.
	it("propagates a history read failure rather than restarting from genesis", async () => {
		await withRollups([row("acme.com", 5)]);
		const { loadAggregateHistory } = await import("@/rollup/aggregate-history");
		vi.mocked(loadAggregateHistory).mockRejectedValue(new Error("cannot read published aggregate history"));

		await expect(vendorAggregateChain("chain-fails")).rejects.toThrow(/cannot read/);
	});
});
