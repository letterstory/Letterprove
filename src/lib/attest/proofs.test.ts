import { beforeEach, describe, expect, it, vi } from "vitest";
import { earned, publishedVendorProof, vendorProof, vendorSnapshots } from "./proofs";

vi.mock("./aggregate", () => ({ vendorAggregate: vi.fn(), publishedVendorAggregate: vi.fn() }));
vi.mock("@/rollup/history", () => ({ loadPersistedChain: vi.fn() }));
vi.mock("../fixtures/vendors", async (importOriginal) => ({
	...(await importOriginal<typeof import("../fixtures/vendors")>()),
	findVendor: vi.fn(),
	findPublishedVendor: vi.fn(),
}));

const VENDOR = {
	id: "v-1",
	slug: "acme",
	name: "Acme",
	domain: "acme.com",
	category: "Analytics",
	key: "k",
	domainVerified: true,
	domainVerifiedAt: "2026-09-02T00:00:00.000Z",
	proofsPublishedAt: "2026-09-10T00:00:00.000Z",
	issuerAffiliation: null,
	customers: [{ slug: "globex", name: "Globex", domain: "globex.com", since: "2024-01", tier: 1 as const, verified: false, features: [] }],
};

const ATTESTATION = {
	vendor: "acme",
	kind: "aggregate" as const,
	domain: "acme.com",
	window_days: 30,
	companies_observed: 12,
	paying_companies: 4,
	sessions: 340,
	signups: 2,
	logins: 90,
	domains_excluded: 1,
	tier: 3 as const,
	observed_through: "2026-10-13T03:05:00.000Z",
	published_at: "2026-10-13T03:05:00.000Z",
	prev_hash: "0".repeat(64),
	method: "m",
	key_id: "lp-test",
	signature: "sig",
};

beforeEach(async () => {
	vi.clearAllMocks();
	const v = await import("../fixtures/vendors");
	const a = await import("./aggregate");
	vi.mocked(v.findVendor).mockResolvedValue(VENDOR as never);
	vi.mocked(v.findPublishedVendor).mockResolvedValue(VENDOR as never);
	vi.mocked(a.vendorAggregate).mockResolvedValue(ATTESTATION as never);
	vi.mocked(a.publishedVendorAggregate).mockResolvedValue(ATTESTATION as never);
});

describe("vendorProof", () => {
	it("is the vendor attestation and a summary read from it — never a customer", async () => {
		const proof = (await vendorProof("acme"))!;
		expect(proof.attestation).toBe(ATTESTATION);
		expect(proof.summary).toEqual({
			tier: 3,
			companies_observed: 12,
			paying_companies: 4,
			sessions_30d: 340,
			last_attested: "2026-10-13T03:05:00.000Z",
		});
		expect(proof).not.toHaveProperty("customers");
		// The vendor's private list is never part of what this returns.
		expect(JSON.stringify(proof)).not.toContain("globex");
	});

	it("reports zeros before the first freeze, not an error", async () => {
		const a = await import("./aggregate");
		vi.mocked(a.vendorAggregate).mockResolvedValue(null);
		const proof = (await vendorProof("acme"))!;
		expect(proof.attestation).toBeNull();
		expect(proof.summary).toEqual({ tier: 0, companies_observed: 0, paying_companies: 0, sessions_30d: 0, last_attested: "" });
	});

	it("is null for an unknown vendor", async () => {
		const v = await import("../fixtures/vendors");
		vi.mocked(v.findVendor).mockResolvedValue(undefined);
		expect(await vendorProof("nope")).toBeNull();
	});
});

describe("publishedVendorProof", () => {
	it("is null for an unpublished vendor, exactly as for an unknown one", async () => {
		const v = await import("../fixtures/vendors");
		vi.mocked(v.findPublishedVendor).mockResolvedValue(undefined);
		expect(await publishedVendorProof("acme")).toBeNull();
	});

	it("reads the gated attestation", async () => {
		const a = await import("./aggregate");
		await publishedVendorProof("acme");
		expect(a.publishedVendorAggregate).toHaveBeenCalledWith("acme");
		expect(a.vendorAggregate).not.toHaveBeenCalled();
	});
});

describe("vendorSnapshots", () => {
	it("reads the retired per-customer history and signs nothing new", async () => {
		const { loadPersistedChain } = await import("@/rollup/history");
		vi.mocked(loadPersistedChain).mockResolvedValue([
			{ hourBucket: 1, attestation: { published_at: "2026-10-12T23:05:00.000Z", verified: false, sessions_30d: 9, features: [] } },
		] as never);
		const out = await vendorSnapshots("acme");
		expect(out).toEqual([
			{ slug: "globex", length: 1, current: { published_at: "2026-10-12T23:05:00.000Z", verified: false, sessions_30d: 9, features: [] } },
		]);
	});
});

describe("earned (the per-domain evidence rule)", () => {
	it("is tier 1, unverified, once sign-ins were observed on a verified domain", () => {
		expect(earned(true, true)).toEqual({ tier: 1, verified: false });
	});

	it("is tier 3 with a settled payment on top", () => {
		expect(earned(true, true, { currency: "usd", monthlyAmount: 100, since: "2025-01-01", subscriptionCount: 1 })).toEqual({
			tier: 3,
			verified: true,
		});
	});

	it("never counts a zero payment", () => {
		expect(earned(true, true, { currency: "usd", monthlyAmount: 0, since: "2025-01-01", subscriptionCount: 1 })).toEqual({
			tier: 1,
			verified: false,
		});
	});

	it("refuses every tier when nothing was observed, payment or not", () => {
		expect(earned(false, true, { currency: "usd", monthlyAmount: 100, since: "2025-01-01", subscriptionCount: 1 })).toEqual({
			tier: 0,
			verified: false,
		});
	});

	it("refuses every tier while the vendor's domain is unverified", () => {
		expect(earned(true, false)).toEqual({ tier: 0, verified: false });
	});

	it("never issues tier 2 or the retired tier 4", () => {
		for (const o of [true, false]) for (const d of [true, false]) expect([2, 4]).not.toContain(earned(o, d).tier);
	});
});
