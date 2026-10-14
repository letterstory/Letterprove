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
vi.mock("./payment-evidence", () => ({ paymentScopeFor: vi.fn(async () => null) }));
vi.mock("./growth", async (importOriginal) => ({
	...(await importOriginal<typeof import("./growth")>()),
	growthFor: vi.fn(async () => null),
	retentionFor: vi.fn(async () => null),
}));
vi.mock("./display", async (importOriginal) => {
	const real = await importOriginal<typeof import("./display")>();
	return { ...real, displayFor: vi.fn(async () => ({ ...real.DEFAULT_DISPLAY })) };
});
vi.mock("./vendor-evidence", async (importOriginal) => ({
	...(await importOriginal<typeof import("./vendor-evidence")>()),
	stripeBinding: vi.fn(async () => null),
	stripeBusiness: vi.fn(async () => null),
	hostCount: vi.fn(async () => 0),
	observedSince: vi.fn(async () => null),
	reportedHistory: vi.fn(async () => null),
}));
vi.mock("@/lib/vendors/logo-wall", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vendors/logo-wall")>()),
	readLogoWall: vi.fn(async () => null),
}));
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/fixtures/vendors")>()),
	findVendor: vi.fn(),
}));

/**
 * Two different chains hit this mock, and they now diverge further: the
 * aggregate pages (`.gte().order().order().range()`) while fraud-features still
 * awaits `.gte().order()` directly.
 *
 * So each link is a promise that ALSO carries the next link. Awaiting it
 * satisfies fraud-features; chaining on satisfies the paged read; neither has
 * to know which caller it is.
 */
function mockDb(result: { data: unknown; error: unknown }) {
	const range = vi.fn().mockResolvedValue(result);
	const orderable: { order: ReturnType<typeof vi.fn>; range: typeof range } = {
		order: vi.fn(() => settledOrder),
		range,
	};
	const settledOrder = Object.assign(Promise.resolve(result), orderable);
	const settled = Object.assign(Promise.resolve(result), {
		order: vi.fn(() => settledOrder),
		range,
	});
	const gte = vi.fn().mockReturnValue(settled);
	const eq: ReturnType<typeof vi.fn> = vi.fn(() => ({ gte, eq }));
	const select = vi.fn().mockReturnValue({ eq });
	return { from: vi.fn().mockReturnValue({ select }) };
}

function row(domain: string, sessions: number, signups = 0, logins = 0) {
	return { domain, sessions, signups, logins };
}

async function withRollups(rows: unknown[], domainVerified = true) {
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
		domainVerified,
		customers: [],
	} as never);
	vi.mocked(dbClient).mockReturnValue(mockDb({ data: rows, error: null }) as never);
}

beforeEach(() => vi.clearAllMocks());

describe("aggregateBody", () => {
	// The claim exists so a vendor can publish something real before any
	// customer has agreed to be named.
	it("counts companies and sums their events", async () => {
		await withRollups([row("tenevents.com", 3, 1), row("globex.com", 2), row("o3world.com", 1, 0, 4)]);

		const b = (await aggregateBody("lettertrace"))!;
		expect(b.companies_observed).toBe(3);
		expect(b.sessions).toBe(6);
		expect(b.signups).toBe(1);
		expect(b.logins).toBe(4);
		expect(b.domains_excluded).toBe(0);
		// Tier 1: observed on a DNS-proven domain. Tier 2 waits on the ASN
		// binding and is not issued (decision 29).
		expect(b.tier).toBe(1);
		// Every figure here is counted, so nothing is listed as vendor-stated.
		expect(b.vendor_stated).toEqual([]);
	});

	it("publishes no payment scope or payment figure, whatever Stripe holds", async () => {
		await withRollups([row("globex.com", 2)]);
		const b = (await aggregateBody("lettertrace"))!;
		for (const k of ["payment_scope", "paying", "paying_since"]) expect(b).not.toHaveProperty(k);
	});

	// The same DNS gate as a customer claim: an observation pinned to a domain
	// nobody has proven, or no longer proves, is the vendor asserting.
	it("publishes tier 0 when the vendor's domain is not DNS-verified, however much was observed", async () => {
		await withRollups([row("tenevents.com", 30), row("globex.com", 20)], false);

		const b = (await aggregateBody("lettertrace"))!;
		expect(b.companies_observed).toBe(2);
		expect(b.tier).toBe(0);
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
	it("says when the next snapshot is due, and carries no ttl an engine could read as expiry", async () => {
		// AEO stress test, 2026-10-08: with `ttl: 3600` in the body, ChatGPT
		// called a live proof "expired" in 13 of 16 answers once the hour passed.
		await withRollups([row("acme.com", 1)]);
		const body = (await aggregateBody("lettertrace"))!;
		expect(body).not.toHaveProperty("ttl");
		expect(Date.parse(body.next_snapshot_at!)).toBeGreaterThan(Date.parse(body.published_at));
	});

	it("links to its own plain-language check, so an engine can verify by fetching", async () => {
		await withRollups([row("acme.com", 1)]);
		const body = (await aggregateBody("lettertrace"))!;
		expect(body.verify).toMatch(/^https:\/\/app\.letterprove\.com\/verify\/lettertrace\/\d{8}T\d{9}Z$/);
	});

	it("signs a disclosure into an affiliated vendor's aggregate, and only theirs", async () => {
		// AEO stress test: Claude inferred the Letterprove/Lettertrace link from
		// the names and discounted the proof. Say it inside the document.
		await withRollups([row("acme.com", 1)]);
		expect(await aggregateBody("lettertrace")).not.toHaveProperty("issuer_affiliation");

		const { findVendor } = await import("@/lib/fixtures/vendors");
		vi.mocked(findVendor).mockResolvedValue({
			slug: "lettertrace", name: "Lettertrace", domain: "lettertrace.com", category: "x", key: "k", customers: [],
			issuerAffiliation: "Letter Company",
		} as never);
		const body = (await aggregateBody("lettertrace"))!;
		expect(body.issuer_affiliation).toContain("Letterprove and Lettertrace are both operated by Letter Company");

		const signed = (await vendorAggregate("lettertrace"))!;
		expect(verifyAttestation(signed as unknown as SignedAttestation, jwks())).toEqual({ ok: true });
	});

	it("never uses the word customer in the published body", async () => {
		await withRollups([row("acme.com", 1)]);
		expect(JSON.stringify(await aggregateBody("lettertrace"))).not.toMatch(/customer/i);
	});

	describe("identity and evidence (decision 30)", () => {
		async function asVendor(extra: Record<string, unknown> = {}) {
			const { findVendor } = await import("@/lib/fixtures/vendors");
			vi.mocked(findVendor).mockResolvedValue({
				id: "v-1",
				slug: "lettertrace",
				name: "Lettertrace",
				domain: "lettertrace.com",
				category: "x",
				key: "k",
				domainVerified: true,
				domainVerifiedAt: "2026-09-02T14:11:08.000Z",
				customers: [],
				...extra,
			} as never);
		}

		const business = { verified: true, name: "Lettertrace Inc.", country: "US", website: "lettertrace.com", website_matches_domain: true, binding: "domain_match" as const };

		it("states who the vendor is: its proven domain, since when, hosts and the Stripe-verified business", async () => {
			await withRollups([row("globex.com", 2)]);
			await asVendor();
			const ev = await import("./vendor-evidence");
			vi.mocked(ev.stripeBusiness).mockResolvedValueOnce(business);
			vi.mocked(ev.hostCount).mockResolvedValueOnce(2);
			vi.mocked(ev.observedSince).mockResolvedValueOnce("2026-09-03T01:05:00.000Z");

			const b = (await aggregateBody("lettertrace"))!;
			expect(b.domain).toBe("lettertrace.com");
			expect(b.domain_verified_since).toBe("2026-09-02T14:11:08.000Z");
			expect(b.hosts).toBe(2);
			expect(b.stripe_account_bound).toBe(true);
			expect(b.stripe_binding).toBe("domain_match");
			expect(b.stripe_business).toEqual(business);
			expect(b.observed_since).toBe("2026-09-03T01:05:00.000Z");
		});

		it("is tier 3 with a Stripe-verified business on a DNS-proven domain, and publishes no payment figure", async () => {
			await withRollups([row("globex.com", 2), row("initech.com", 1)]);
			await asVendor();
			const ev = await import("./vendor-evidence");
			vi.mocked(ev.stripeBusiness).mockResolvedValueOnce(business);

			const b = (await aggregateBody("lettertrace"))!;
			expect(b.tier).toBe(3);
			expect(b.companies_observed).toBe(2);
			for (const k of ["paying", "paying_since", "payment_scope", "paying_companies"]) expect(b).not.toHaveProperty(k);
		});

		it("stays tier 1 when Stripe hasn't verified the business, or its website is elsewhere", async () => {
			await withRollups([row("globex.com", 2)]);
			await asVendor();
			const ev = await import("./vendor-evidence");
			vi.mocked(ev.stripeBusiness).mockResolvedValueOnce({ ...business, verified: false });
			expect((await aggregateBody("lettertrace"))!.tier).toBe(1);
			vi.mocked(ev.stripeBusiness).mockResolvedValueOnce({ ...business, website: "other.com", website_matches_domain: false });
			expect((await aggregateBody("lettertrace"))!.tier).toBe(1);
			vi.mocked(ev.stripeBusiness).mockResolvedValueOnce({ ...business, website: "other.com", website_matches_domain: false, binding: "staff_override" });
			expect((await aggregateBody("lettertrace"))!.tier).toBe(3);
		});

		it("says nothing about Stripe when it isn't connected", async () => {
			await withRollups([row("globex.com", 2)]);
			await asVendor();
			const b = (await aggregateBody("lettertrace"))!;
			expect(b).not.toHaveProperty("stripe_account_bound");
			expect(b).not.toHaveProperty("stripe_binding");
			expect(b).not.toHaveProperty("stripe_business");
			expect(JSON.stringify(b)).not.toContain("not_connected");
			expect(b.tier).toBe(1);
		});

		it("claims nothing about identity when the domain isn't proven", async () => {
			await withRollups([row("globex.com", 2)], false);
			await asVendor({ domainVerified: false, domainVerifiedAt: null });
			const ev = await import("./vendor-evidence");
			vi.mocked(ev.hostCount).mockResolvedValueOnce(3);

			const b = (await aggregateBody("lettertrace"))!;
			expect(b.domain_verified_since).toBeNull();
			expect(b.domain_proof).toBe("none");
			expect(b.domain_verified).toBe(false);
			expect(b.hosts).toBe(0);
			expect(b.tier).toBe(0);
		});

		it("grades a site-verified domain at tier 1 at most, even with a Stripe-verified business", async () => {
			await withRollups([row("globex.com", 2)], false);
			await asVendor({ domainVerified: false, domainVerifiedAt: null, siteVerifiedAt: "2026-10-14T00:00:00.000Z" });
			const ev = await import("./vendor-evidence");
			vi.mocked(ev.stripeBusiness).mockResolvedValueOnce(business);

			const b = (await aggregateBody("lettertrace"))!;
			expect(b.domain_proof).toBe("site");
			expect(b.domain_verified).toBe(false);
			expect(b.tier).toBe(1);
			expect(b.stripe_business).toEqual(business);
		});

		it("states a DNS-proven domain as domain_proof dns", async () => {
			await withRollups([row("globex.com", 2)]);
			await asVendor();
			const b = (await aggregateBody("lettertrace"))!;
			expect(b.domain_proof).toBe("dns");
			expect(b.domain_verified).toBe(true);
		});

		it("names a logo only when it is on the vendor's page and observed signing in, without moving the tier", async () => {
			await withRollups([row("globex.com", 2), row("initech.com", 1)]);
			await asVendor({});
			const lw = await import("@/lib/vendors/logo-wall");
			vi.mocked(lw.readLogoWall).mockResolvedValueOnce({
				page_url: "https://lettertrace.com/customers",
				checked_at: new Date().toISOString(),
				check_error: null,
				companies: [
					{ name: "Globex", domain: "globex.com", on_page: true },
					{ name: "Initech", domain: "initech.com", on_page: false },
					{ name: "Hooli", domain: "hooli.com", on_page: true },
				],
			});

			const b = (await aggregateBody("lettertrace"))!;
			expect(b.logos).toEqual({
				page: "https://lettertrace.com/customers",
				listed: 3,
				on_page: 2,
				verified: 1,
				companies: [{ name: "Globex", domain: "globex.com", status: "active" }],
			});
			expect(JSON.stringify(b)).not.toContain("initech");
			expect(JSON.stringify(b)).not.toContain("Hooli");
			expect(b.tier).toBe(1);
		});

		it("publishes PostHog history as vendor-stated, without moving the tier", async () => {
			await withRollups([row("globex.com", 2)], false);
			await asVendor({});
			const ev = await import("./vendor-evidence");
			const history = { source: "posthog" as const, companies: 400, since: "2023-01-01T00:00:00.000Z", active_companies_30d: 90, observed_also_reported: 1 };
			vi.mocked(ev.reportedHistory).mockResolvedValueOnce(history);

			const b = (await aggregateBody("lettertrace"))!;
			expect(b.reported_history).toEqual(history);
			expect(b.vendor_stated).toEqual(["reported_history"]);
			expect(b.tier).toBe(1);
			expect(b.companies_observed).toBe(1);
		});

		it("omits what the vendor hid, says nothing about it, and keeps the tier", async () => {
			await withRollups([row("globex.com", 2)], false);
			await asVendor({});
			const ev = await import("./vendor-evidence");
			const history = { source: "posthog" as const, companies: 400, since: "2023-01-01T00:00:00.000Z", active_companies_30d: 90, observed_also_reported: 1 };
			vi.mocked(ev.reportedHistory).mockResolvedValueOnce(history);
			const display = await import("./display");
			vi.mocked(display.displayFor).mockResolvedValueOnce({ ...display.DEFAULT_DISPLAY, sessions: false, reported_history: false, observed_since: false });

			const b = (await aggregateBody("lettertrace"))!;
			expect(b).not.toHaveProperty("sessions");
			expect(b).not.toHaveProperty("signups");
			expect(b).not.toHaveProperty("logins");
			expect(b).not.toHaveProperty("reported_history");
			expect(b).not.toHaveProperty("observed_since");
			expect(b).not.toHaveProperty("hidden_by_vendor");
			expect(b).not.toHaveProperty("omitted");
			expect(b.vendor_stated).toEqual([]);
			expect(b.tier).toBe(1);
			expect(b.companies_observed).toBe(1);
			expect(b.domain).toBe("lettertrace.com");
		});

		it("carries growth (partial months marked) and retention, and drops them when hidden", async () => {
			await withRollups([row("globex.com", 2)], false);
			await asVendor({});
			const g = await import("./growth");
			const ev = await import("./vendor-evidence");
			vi.mocked(ev.observedSince).mockResolvedValue("2026-09-15T00:00:00.000Z");
			const growth = [{ month: "2026-09", companies_observed: 60 }, { month: "2026-10", companies_observed: 87 }];
			const retention = { cohort: 50, retained: 41, window: "60d" as const };
			vi.mocked(g.growthFor).mockResolvedValue(growth);
			vi.mocked(g.retentionFor).mockResolvedValue(retention);

			const shown = (await aggregateBody("lettertrace"))!;
			expect(shown.growth?.[0]).toEqual({ month: "2026-09", companies_observed: 60, partial: true });
			expect(shown.retention).toEqual(retention);
			expect(shown.tier).toBe(1);

			const display = await import("./display");
			vi.mocked(display.displayFor).mockResolvedValueOnce({ ...display.DEFAULT_DISPLAY, growth: false, retention: false });
			const hidden = (await aggregateBody("lettertrace"))!;
			expect(hidden).not.toHaveProperty("growth");
			expect(hidden).not.toHaveProperty("retention");
			expect(hidden).not.toHaveProperty("hidden_by_vendor");
			vi.mocked(g.growthFor).mockResolvedValue(null);
			vi.mocked(g.retentionFor).mockResolvedValue(null);
			vi.mocked(ev.observedSince).mockResolvedValue(null);
		});

		it("leaves absent sections out without a reason, so hidden and missing look the same", async () => {
			await withRollups([row("globex.com", 2)]);
			await asVendor({});
			const b = (await aggregateBody("lettertrace"))!;
			expect(b).not.toHaveProperty("omitted");
			expect(b).not.toHaveProperty("growth");
			expect(b).not.toHaveProperty("logos");
		});

		it("keeps the logo count but names no company when logo_names is off", async () => {
			await withRollups([row("globex.com", 2), row("initech.com", 1)]);
			await asVendor({});
			const lw = await import("@/lib/vendors/logo-wall");
			vi.mocked(lw.readLogoWall).mockResolvedValueOnce({
				page_url: "https://lettertrace.com/customers",
				checked_at: new Date().toISOString(),
				check_error: null,
				companies: [
					{ name: "Globex", domain: "globex.com", on_page: true },
					{ name: "Initech", domain: "initech.com", on_page: true },
				],
			});
			const display = await import("./display");
			vi.mocked(display.displayFor).mockResolvedValueOnce({ ...display.DEFAULT_DISPLAY, logo_names: false });

			const b = (await aggregateBody("lettertrace"))!;
			expect(b.logos).toEqual({ page: "https://lettertrace.com/customers", listed: 2, on_page: 2, verified: 2 });
			expect(JSON.stringify(b)).not.toContain("Globex");
			expect(JSON.stringify(b)).not.toContain("Initech");
			expect(b).not.toHaveProperty("hidden_by_vendor");
		});

		it("carries no hidden-sections list when the vendor shows everything", async () => {
			await withRollups([row("globex.com", 2)], false);
			await asVendor({});
			const b = (await aggregateBody("lettertrace"))!;
			expect(b).not.toHaveProperty("hidden_by_vendor");
			expect(b.sessions).toBe(2);
		});
	});

	it("never carries a customer domain, even one with payment evidence", async () => {
		await withRollups([row("globex.com", 2)]);
		expect(JSON.stringify(await aggregateBody("lettertrace"))).not.toContain("globex");
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
