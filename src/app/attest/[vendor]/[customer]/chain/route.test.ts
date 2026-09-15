import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, snapshotHash } from "@/lib/attest/verify";
import { GET } from "./route";

/**
 * The customer chain, tested through the route rather than through
 * customerChain(), because the two do not agree about consent and only the
 * route is what an agent can actually fetch.
 *
 * Real proofs.ts underneath; only identity and telemetry are mocked.
 */

vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));
vi.mock("@/rollup/history", () => ({ loadPersistedChain: vi.fn() }));

vi.mock("@/lib/fixtures/vendors", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/fixtures/vendors")>();
	const VENDORS: import("@/lib/fixtures/vendors").VendorFixture[] = [
		{
			id: "00000000-0000-0000-0000-000000000001",
			slug: "vantage",
			name: "Vantage",
			domain: "vantage.example",
			category: "customer data platforms",
			key: "lp_live_vantage_9f2c",
			domainVerified: true,
			proofsPublishedAt: "2026-01-01T00:00:00.000Z",
			customers: [
				{ slug: "acme-corp", name: "Acme Corp", domain: "acme-corp.example", since: "2023-03", tier: 2, verified: true, features: ["sso", "api"], consent: "named" },
				{ slug: "northwind", name: "Northwind", domain: "northwind.example", since: "2024-08", tier: 2, verified: true, features: ["sso"], consent: "anonymous" },
				{ slug: "globex", name: "Globex", domain: "globex.example", since: "2022-11", tier: 1, verified: false, features: ["api"] },
			],
		},
	];
	return {
		...original,
		allVendors: async () => VENDORS,
		findVendor: async (slug: string) => VENDORS.find((v) => v.slug === slug),
		// `findPublishedVendor` has to be mocked alongside `findVendor`, not left
		// to the spread: it calls `findVendor` through the module's own binding,
		// which the spread does not replace, so the real (DB-backed, unconfigured
		// here) lookup would run and every public route would 404.
		findPublishedVendor: async (slug: string) => {
			const vendor = VENDORS.find((v) => v.slug === slug);
			return vendor && vendor.proofsPublishedAt !== null ? vendor : undefined;
		},
	};
});

import { currentSnapshot } from "@/rollup/snapshots";
import { loadPersistedChain } from "@/rollup/history";
import type { SignedAttestation } from "@/lib/attest/types";

function get(vendor: string, customer: string) {
	return GET(new Request(`https://www.letterprove.com/attest/${vendor}/${customer}/chain`), {
		params: Promise.resolve({ vendor, customer }),
	});
}

function atHour(iso: string) {
	vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(loadPersistedChain).mockReset().mockResolvedValue([]);
	vi.mocked(currentSnapshot).mockReset().mockResolvedValue({
		observed_through: "2026-08-01T00:00:00.000Z",
		published_at: "2026-08-01T00:00:00.000Z",
		sessions_30d: 42,
		seats_active: 3,
		observed: true,
		readOk: true,
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("GET /attest/[vendor]/[customer]/chain — consent", () => {
	it("serves a consenting customer's full history, oldest first", async () => {
		atHour("2026-08-01T00:00:00.000Z");

		const res = await get("vantage", "acme-corp");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.vendor).toBe("vantage");
		expect(body.customer).toBe("acme-corp");
		expect(body.chain).toHaveLength(body.length);
	});

	// Regression guard for the leak fixed alongside these tests: customerChain()
	// is deliberately ungated (vendorProof and the vendor's own dashboard read
	// it through a bearer token), and this public route used to call it
	// directly. That published a withheld customer's display name and their
	// entire signed history to anyone who appended /chain — past the very gate
	// the sibling route enforces. Consent has to hold on every public spelling
	// of a named document, not just the shortest one.
	it("404s a customer who declared anonymous consent", async () => {
		atHour("2026-08-01T01:00:00.000Z");

		const res = await get("vantage", "northwind");

		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain("Northwind");
	});

	it("404s a customer whose fixture never mentions consent", async () => {
		atHour("2026-08-01T02:00:00.000Z");

		const res = await get("vantage", "globex");

		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain("Globex");
	});

	it("answers an unknown customer and a withheld one with the same 404", async () => {
		atHour("2026-08-01T03:00:00.000Z");
		const unknown = await get("vantage", "no-such-customer");
		atHour("2026-08-01T04:00:00.000Z");
		const withheld = await get("vantage", "northwind");

		expect(unknown.status).toBe(withheld.status);
		const [a, b] = await Promise.all([unknown.json(), withheld.json()]);
		expect(a.error).toBe("not_found");
		expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
		expect(b.detail.replace(/"[^"]*"/, '"<slug>"')).toBe(a.detail.replace(/"[^"]*"/, '"<slug>"'));
	});

	it("never composes a chain for a non-consenting customer", async () => {
		// The gate has to short-circuit before the history read, or a withheld
		// customer still costs a rollup query on every public fetch.
		atHour("2026-08-01T06:00:00.000Z");

		await get("vantage", "northwind");

		expect(loadPersistedChain).not.toHaveBeenCalled();
		expect(currentSnapshot).not.toHaveBeenCalled();
	});

	it("404s an unknown vendor", async () => {
		atHour("2026-08-01T05:00:00.000Z");

		expect((await get("no-such-vendor", "acme-corp")).status).toBe(404);
	});
});

describe("GET /attest/[vendor]/[customer]/chain — chain integrity as served", () => {
	// A chain is only auditable if the ORDER and the LINKAGE survive
	// serialisation. Computing them correctly and then serving them shuffled
	// would verify entry-by-entry and still be a forgeable history.
	const frozen = (hourBucket: number, attestation: SignedAttestation) => ({ hourBucket, attestation });

	it("serves the persisted entries oldest first, each linked to its predecessor", async () => {
		atHour("2026-08-05T00:00:00.000Z");
		// Compose a real two-entry persisted history by letting the live path
		// build entry one, then replaying it as frozen.
		vi.mocked(loadPersistedChain).mockResolvedValue([]);
		const first = await (await get("vantage", "acme-corp")).json();
		const head: SignedAttestation = first.chain[0];

		atHour("2026-08-05T01:00:00.000Z");
		vi.mocked(loadPersistedChain).mockResolvedValue([frozen(Math.floor(Date.parse("2026-08-05T00:00:00.000Z") / 3_600_000), head)] as never);

		const body = await (await get("vantage", "acme-corp")).json();

		expect(body.length).toBe(2);
		expect(body.chain[0].prev_hash).toBe(GENESIS_HASH);
		expect(body.chain[1].prev_hash).toBe(snapshotHash(body.chain[0]));
		// Oldest first, not newest first: published_at must be non-decreasing.
		expect(body.chain[0].published_at <= body.chain[1].published_at).toBe(true);
	});

	it("starts the first entry at the genesis hash, so a truncated history cannot pass as complete", async () => {
		atHour("2026-08-06T00:00:00.000Z");

		const body = await (await get("vantage", "acme-corp")).json();

		expect(body.chain[0].prev_hash).toBe(GENESIS_HASH);
	});

	it("reports a length that matches the chain it actually shipped", async () => {
		atHour("2026-08-06T01:00:00.000Z");

		const body = await (await get("vantage", "acme-corp")).json();

		expect(body.length).toBe(body.chain.length);
	});
});

describe("GET /attest/[vendor]/[customer]/chain — cache headers", () => {
	it("uses the short named-document window, not the hour-long aggregate one", async () => {
		// The chain names the customer in every entry, so it is subject to the
		// same withdrawal deadline as the current document.
		atHour("2026-08-07T00:00:00.000Z");

		const res = await get("vantage", "acme-corp");

		expect(res.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});

describe("GET /attest/[vendor]/[customer]/chain — the .json suffix", () => {
	// PINNED AS-IS, NOT AS WISHED. The sibling document route strips a trailing
	// `.json`; this one does not, so `/attest/v/c.json/chain` is a 404. Nothing
	// advertises that URL, so it is documented rather than changed — but if the
	// suffix is ever made general, this is the test that will tell you.
	it("does not strip a .json suffix from the customer segment", async () => {
		atHour("2026-08-08T00:00:00.000Z");

		expect((await get("vantage", "acme-corp.json")).status).toBe(404);
	});
});

describe("GET /attest/[vendor]/[customer]/chain — access logging", () => {
	it("logs the chain subject distinctly from the document subject", async () => {
		atHour("2026-08-09T00:00:00.000Z");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await get("vantage", "acme-corp");

		const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[letterprove:access]"));
		expect(JSON.parse(line!.slice("[letterprove:access] ".length)).subject).toBe("vantage/acme-corp/chain");
	});
});
