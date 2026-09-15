import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A vendor is PRIVATE until someone publishes it.
 *
 * The bug this suite pins, found in production on 09-14: a vendor went public
 * the instant its row existed. Creating `letterstory` as a second vendor — for
 * fraud calibration, and to dogfood our own install — immediately served a
 * signed aggregate at /attest/letterstory, and installing the collector would
 * have turned that document's zeros into a public, signed count of how many
 * companies use Letterstory, before Letterprove had launched and before anyone
 * had decided to say it.
 *
 * What is gated is PUBLICATION ONLY. Collection, rollup, freeze, signing and
 * countersigning all keep running while a vendor is private, so the chain has
 * no hole in it and going public is a flip rather than a rebuild. Those are
 * two separate claims and this file tests both:
 *
 *   1. every public spelling of a document 404s for a private vendor, with the
 *      same 404 an unknown vendor gets;
 *   2. everything internal keeps working, and the flip changes nothing but
 *      reachability.
 *
 * The mocks here stop at the DATABASE boundary rather than at the library
 * boundary, deliberately. A test that mocked `publishedVendorAggregate` would
 * pass just as happily against a route that called the ungated one — which is
 * precisely the shape of the bug.
 */

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/rollup/aggregate-history", () => ({ loadAggregateHistory: vi.fn() }));
vi.mock("@/rollup/history", () => ({ loadPersistedChain: vi.fn() }));
vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));
vi.mock("@/lib/tiers/report", () => ({ tierReport: vi.fn() }));
vi.mock("@/lib/access/log", () => ({ logProofAccess: vi.fn() }));
// Reached transitively through countersign -> fraudFeatures, against a query
// shape the db mock below is not built for. Nothing here is about arrival
// timing or geography.
vi.mock("./domain-arrivals", () => ({
	domainArrivals: vi.fn().mockResolvedValue({ vendor_first_seen: null, first_seen: [] }),
}));
vi.mock("./geo-distribution", () => ({
	geoDistribution: vi.fn().mockResolvedValue({ regions: {}, unknown: 0, distinctRegions: 0 }),
}));

/**
 * Two vendors, identical but for one field. Every assertion below is a
 * comparison between them, so nothing can pass by accident of an empty
 * fixture or an unreachable datastore.
 *
 * `findPublishedVendor` has to be defined here rather than left to the spread:
 * inside the real module it calls `findVendor` through the module's own
 * binding, which a partial mock does not replace.
 */
const PUBLIC_VENDOR = {
	id: "00000000-0000-0000-0000-0000000000a1",
	slug: "lettertrace",
	name: "Lettertrace",
	domain: "lettertrace.com",
	category: "AI brand monitoring",
	key: "lp_live_lettertrace",
	domainVerified: true,
	proofsPublishedAt: "2026-01-01T00:00:00.000Z" as string | null,
	customers: [
		{
			slug: "tenevents",
			name: "Ten Events",
			domain: "tenevents.com",
			since: "2025-01",
			tier: 2 as const,
			verified: true,
			features: ["sso"],
			consent: "named" as const,
		},
	],
};

const PRIVATE_VENDOR = {
	...PUBLIC_VENDOR,
	id: "00000000-0000-0000-0000-0000000000a2",
	slug: "letterstory",
	name: "Letterstory",
	domain: "app.letterstory.com",
	key: "lp_live_letterstory",
	proofsPublishedAt: null as string | null,
	customers: [{ ...PUBLIC_VENDOR.customers[0] }],
};

const VENDORS = [PUBLIC_VENDOR, PRIVATE_VENDOR];

vi.mock("@/lib/fixtures/vendors", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/fixtures/vendors")>();
	return {
		...original,
		allVendors: async () => VENDORS,
		publishedVendors: async () => VENDORS.filter((v) => v.proofsPublishedAt !== null),
		findVendor: async (slug: string) => VENDORS.find((v) => v.slug === slug),
		findPublishedVendor: async (slug: string) => {
			const vendor = VENDORS.find((v) => v.slug === slug);
			return vendor && vendor.proofsPublishedAt !== null ? vendor : undefined;
		},
	};
});

/**
 * The query shapes this suite's call graph reaches for: the paged rollup read
 * (`observedTotals`), the awaited one (`fraudFeatures`), and the single-row
 * payment-evidence lookup. `maybeSingle` answers "no row", which is the
 * ordinary state — no Stripe evidence — rather than an error.
 */
function mockDb(rows: { domain: string; sessions: number; signups: number; logins: number }[]) {
	const result = { data: rows, error: null };
	const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
	const range = vi.fn().mockResolvedValue(result);
	// Each link is a promise that ALSO carries the next link: awaiting it
	// satisfies the callers that await `.order()` directly, chaining on
	// satisfies the paged read, and neither has to know which caller it is.
	const chainable: { order: ReturnType<typeof vi.fn>; range: typeof range; maybeSingle: typeof maybeSingle } = {
		order: vi.fn(() => settledOrder),
		range,
		maybeSingle,
	};
	const settledOrder = Object.assign(Promise.resolve(result), chainable);
	const settled = Object.assign(Promise.resolve(result), {
		order: vi.fn(() => settledOrder),
		range,
		maybeSingle,
	});
	const gte = vi.fn().mockReturnValue(settled);
	const eq: ReturnType<typeof vi.fn> = vi.fn(() => ({ gte, eq, maybeSingle, order: vi.fn(() => settledOrder) }));
	return { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq, gte, maybeSingle }) }) };
}

beforeEach(async () => {
	vi.clearAllMocks();
	PRIVATE_VENDOR.proofsPublishedAt = null;
	PUBLIC_VENDOR.proofsPublishedAt = "2026-01-01T00:00:00.000Z";

	const { dbClient } = await import("@/lib/db/client");
	const { loadAggregateHistory } = await import("@/rollup/aggregate-history");
	const { loadPersistedChain } = await import("@/rollup/history");
	const { currentSnapshot } = await import("@/rollup/snapshots");
	const { tierReport } = await import("@/lib/tiers/report");

	vi.mocked(dbClient).mockReturnValue(mockDb([{ domain: "tenevents.com", sessions: 7, signups: 1, logins: 2 }]) as never);
	vi.mocked(loadAggregateHistory).mockResolvedValue([]);
	vi.mocked(loadPersistedChain).mockResolvedValue([]);
	vi.mocked(currentSnapshot).mockResolvedValue({
		observed_through: "2026-09-14T00:00:00.000Z",
		published_at: "2026-09-14T00:00:00.000Z",
		sessions_30d: 7,
		seats_active: 0,
		observed: true,
		readOk: true,
	});
	vi.mocked(tierReport).mockResolvedValue({ observed: 1, attributable: 1, published: 1, unpublishedEvidence: 0, rows: [] } as never);
});

describe("the publication gate, at the library boundary", () => {
	it("resolves a private vendor for internal callers and refuses it for public ones", async () => {
		const { findVendor, findPublishedVendor } = await import("@/lib/fixtures/vendors");

		expect(await findVendor("letterstory")).toBeDefined();
		expect(await findPublishedVendor("letterstory")).toBeUndefined();
		expect(await findPublishedVendor("lettertrace")).toBeDefined();
	});

	/*
	 * Undefined, not a distinct "private" result. An unpublished vendor must be
	 * indistinguishable from one that does not exist — otherwise guessing slugs
	 * confirms which companies have installed Letterprove and not launched yet,
	 * which is a fact about someone else's roadmap.
	 */
	it("answers a private vendor exactly as it answers an unknown one", async () => {
		const { findPublishedVendor } = await import("@/lib/fixtures/vendors");

		expect(await findPublishedVendor("letterstory")).toBe(await findPublishedVendor("no-such-vendor"));
	});

	it("keeps a private vendor out of every listing a stranger reads", async () => {
		const { allVendors, publishedVendors } = await import("@/lib/fixtures/vendors");
		const { vendorSlugs, publishedVendorSlugs } = await import("./proofs");

		expect((await allVendors()).map((v) => v.slug)).toEqual(["lettertrace", "letterstory"]);
		expect((await publishedVendors()).map((v) => v.slug)).toEqual(["lettertrace"]);
		expect(await vendorSlugs()).toEqual(["lettertrace", "letterstory"]);
		expect(await publishedVendorSlugs()).toEqual(["lettertrace"]);
	});

	/*
	 * Discovery is the first document an agent reads. A private vendor named
	 * and linked there would make the 404s behind it a formality.
	 */
	it("never advertises a private vendor in the discovery document", async () => {
		const { discoveryDocument } = await import("./discovery");

		const doc = await discoveryDocument("https://app.letterprove.com");

		expect(doc.proofs.map((p) => p.vendor)).toEqual(["lettertrace"]);
		// Not merely absent from `proofs`: absent from every URL the document
		// hands an agent. (`method`/`verifier` point at the GitHub org, which is
		// also called letterstory — hence the narrower check.)
		expect(doc.proofs.flatMap((p) => [p.url, p.aggregate, p.aggregate_chain]).join(" ")).not.toContain("letterstory");
	});

	it("gates the vendor proof without gating the composition behind it", async () => {
		const { vendorProof, publishedVendorProof } = await import("./proofs");

		// Ungated: `get_proof_summary` is a vendor reading their own rollup back.
		expect(await vendorProof("letterstory")).not.toBeNull();
		expect(await publishedVendorProof("letterstory")).toBeNull();
		expect(await publishedVendorProof("lettertrace")).not.toBeNull();
	});

	it("gates the aggregate without gating the chain that the freeze builds", async () => {
		const { vendorAggregate, vendorAggregateChain, publishedVendorAggregate, publishedVendorAggregateChain } =
			await import("./aggregate");

		expect(await vendorAggregate("letterstory")).not.toBeNull();
		expect(await vendorAggregateChain("letterstory")).not.toBeNull();
		expect(await publishedVendorAggregate("letterstory")).toBeNull();
		expect(await publishedVendorAggregateChain("letterstory")).toBeNull();
		expect(await publishedVendorAggregate("lettertrace")).not.toBeNull();
	});

	/*
	 * Two consents, one door. The customer agreed to be named; the vendor has
	 * not published. A customer who consented early must not be the thing that
	 * launches the vendor.
	 */
	it("withholds a consenting customer of a private vendor, while still chaining them", async () => {
		const { customerChain, customerProof } = await import("./proofs");

		expect(await customerChain("letterstory", "tenevents")).not.toBeNull();
		expect(await customerProof("letterstory", "tenevents")).toBeNull();
		expect(await customerProof("lettertrace", "tenevents")).not.toBeNull();
	});

	it("keeps the vendor's own read-back of their snapshots ungated", async () => {
		const { vendorSnapshots } = await import("./proofs");

		// A vendor reading their own data through a token scoped to their own
		// vendor id is not publication — the same trust boundary as
		// list_customers.
		expect(await vendorSnapshots("letterstory")).toHaveLength(1);
	});
});

describe("every public route, for a private vendor", () => {
	const req = (url: string) => new Request(url);

	it("404s the aggregate", async () => {
		const { GET } = await import("@/app/attest/[vendor]/route");

		const priv = await GET(req("https://x/attest/letterstory"), { params: Promise.resolve({ vendor: "letterstory" }) });
		const pub = await GET(req("https://x/attest/lettertrace"), { params: Promise.resolve({ vendor: "lettertrace" }) });

		expect(priv.status).toBe(404);
		expect(pub.status).toBe(200);
	});

	it("404s the aggregate chain", async () => {
		const { GET } = await import("@/app/attest/[vendor]/chain/route");

		const priv = await GET(req("https://x/attest/letterstory/chain"), { params: Promise.resolve({ vendor: "letterstory" }) });
		const pub = await GET(req("https://x/attest/lettertrace/chain"), { params: Promise.resolve({ vendor: "lettertrace" }) });

		expect(priv.status).toBe(404);
		expect(pub.status).toBe(200);
	});

	it("404s a named customer's attestation", async () => {
		const { GET } = await import("@/app/attest/[vendor]/[customer]/route");

		const priv = await GET(req("https://x/attest/letterstory/tenevents"), {
			params: Promise.resolve({ vendor: "letterstory", customer: "tenevents" }),
		});
		const pub = await GET(req("https://x/attest/lettertrace/tenevents"), {
			params: Promise.resolve({ vendor: "lettertrace", customer: "tenevents" }),
		});

		expect(priv.status).toBe(404);
		expect(pub.status).toBe(200);
	});

	// The spelling that got past the consent gate once already (#137). Every
	// public spelling of a document has to clear the same gate, not the shortest.
	it("404s that customer's chain too", async () => {
		const { GET } = await import("@/app/attest/[vendor]/[customer]/chain/route");

		const priv = await GET(req("https://x/attest/letterstory/tenevents/chain"), {
			params: Promise.resolve({ vendor: "letterstory", customer: "tenevents" }),
		});
		const pub = await GET(req("https://x/attest/lettertrace/tenevents/chain"), {
			params: Promise.resolve({ vendor: "lettertrace", customer: "tenevents" }),
		});

		expect(priv.status).toBe(404);
		expect(pub.status).toBe(200);
	});

	// The machine half of /proofs/{vendor}, which proxy.ts rewrites to on an
	// `Accept: application/json`. The HTML half 404s in its layout; this one
	// would otherwise have answered 200 with the whole summary.
	it("404s the JSON proof report", async () => {
		const { GET } = await import("@/app/api/proofs/[vendor]/route");

		const priv = await GET(req("https://x/api/proofs/letterstory"), { params: Promise.resolve({ vendor: "letterstory" }) });
		const pub = await GET(req("https://x/api/proofs/lettertrace"), { params: Promise.resolve({ vendor: "lettertrace" }) });

		expect(priv.status).toBe(404);
		expect(pub.status).toBe(200);
	});

	it("says nothing a 404 for an unknown vendor would not say", async () => {
		const { GET } = await import("@/app/attest/[vendor]/route");

		const priv = await GET(req("https://x/attest/letterstory"), { params: Promise.resolve({ vendor: "letterstory" }) });
		const unknown = await GET(req("https://x/attest/nobody"), { params: Promise.resolve({ vendor: "nobody" }) });

		const shape = (body: { error: string; detail: string }) => ({ error: body.error, detail: body.detail.replace(/"[^"]*"/, '"X"') });
		expect(shape(await priv.json())).toEqual(shape(await unknown.json()));
	});
});

describe("publishing is a flip, not a rebuild", () => {
	/*
	 * The property that makes "collect privately, go public deliberately"
	 * worth having. If publication had to rebuild anything, a vendor's public
	 * history would start on launch day — and the whole claim of the product
	 * is a chain that reaches back to the first observation.
	 */
	it("serves the chain that was already built while the vendor was private", async () => {
		const { vendorAggregateChain, publishedVendorAggregateChain } = await import("./aggregate");
		const { loadAggregateHistory } = await import("@/rollup/aggregate-history");

		const whilePrivate = await vendorAggregateChain("letterstory");
		const readsBefore = vi.mocked(loadAggregateHistory).mock.calls.length;

		PRIVATE_VENDOR.proofsPublishedAt = "2026-09-14T12:00:00.000Z";
		const whenPublished = await publishedVendorAggregateChain("letterstory");

		// The same signed entries, byte for byte — not a re-signed equivalent.
		expect(whenPublished).toEqual(whilePrivate);
		expect(JSON.stringify(whenPublished)).toBe(JSON.stringify(whilePrivate));
		// And nothing was re-read or re-signed to produce it.
		expect(vi.mocked(loadAggregateHistory).mock.calls).toHaveLength(readsBefore);
	});

	it("serves the customer history that was already built while the vendor was private", async () => {
		const { customerChain, customerProof } = await import("./proofs");
		const { loadPersistedChain } = await import("@/rollup/history");

		const whilePrivate = await customerChain("letterstory", "tenevents");
		const readsBefore = vi.mocked(loadPersistedChain).mock.calls.length;

		PRIVATE_VENDOR.proofsPublishedAt = "2026-09-14T12:00:00.000Z";
		const proof = await customerProof("letterstory", "tenevents");

		expect(proof!.chain).toEqual(whilePrivate);
		expect(vi.mocked(loadPersistedChain).mock.calls).toHaveLength(readsBefore);
	});

	it("takes the proofs back down when the flag goes back to null", async () => {
		const { publishedVendorAggregate } = await import("./aggregate");

		PRIVATE_VENDOR.proofsPublishedAt = "2026-09-14T12:00:00.000Z";
		expect(await publishedVendorAggregate("letterstory")).not.toBeNull();

		PRIVATE_VENDOR.proofsPublishedAt = null;
		expect(await publishedVendorAggregate("letterstory")).toBeNull();
	});
});
