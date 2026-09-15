import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * Route-level tests for the one endpoint where a mistake is a privacy
 * incident rather than a bug report: the document that names a third party.
 *
 * These run the REAL proofs.ts underneath and mock only the two things a
 * route cannot own — identity lookup and telemetry — because the property
 * that matters is "a customer who did not consent is never served", and a
 * mocked `customerProof` would prove nothing about that. Mock the gate and
 * you have tested your mock.
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
				// Consent omitted entirely, which fixtures.consentOf reads as
				// `anonymous`. Worth a customer of its own: the accidental case is
				// the one a route is most likely to get wrong.
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

function get(vendor: string, customer: string, headers: Record<string, string> = {}) {
	return GET(new Request(`https://www.letterprove.com/attest/${vendor}/${customer}`, { headers }), {
		params: Promise.resolve({ vendor, customer }),
	});
}

// proofs.ts memoises composed chains in a module-level Map keyed by
// vendor/customer/hour, and nothing resets it between tests. Pin a distinct
// hour per test rather than inventing a fixture slug per test.
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

describe("GET /attest/[vendor]/[customer] — consent at the HTTP layer", () => {
	it("serves a consenting customer's current attestation", async () => {
		atHour("2026-08-01T00:00:00.000Z");

		const res = await get("vantage", "acme-corp");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.customer).toBe("acme-corp");
		expect(body.customer_name).toBe("Acme Corp");
		expect(body.signature).toBeTruthy();
	});

	it("404s a customer who declared anonymous consent", async () => {
		atHour("2026-08-01T01:00:00.000Z");

		const res = await get("vantage", "northwind");

		expect(res.status).toBe(404);
		// The name must not reach the wire at all, not even in an error detail.
		expect(await res.text()).not.toContain("Northwind");
	});

	it("404s a customer whose fixture never mentions consent, because absent means withheld", async () => {
		atHour("2026-08-01T02:00:00.000Z");

		const res = await get("vantage", "globex");

		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain("Globex");
	});

	it("never touches telemetry for a non-consenting customer", async () => {
		// Not merely a privacy nicety: the gate has to short-circuit BEFORE the
		// chain is composed, or a withheld customer still costs a rollup read on
		// every public fetch and becomes a free way to probe our load.
		atHour("2026-08-01T03:00:00.000Z");

		await get("vantage", "northwind");

		expect(currentSnapshot).not.toHaveBeenCalled();
		expect(loadPersistedChain).not.toHaveBeenCalled();
	});
});

describe("GET /attest/[vendor]/[customer] — the three 404s are indistinguishable", () => {
	// An endpoint that answered differently for "no such customer" and "that
	// customer exists but said no" would confirm the existence of a private
	// customer to anyone willing to guess slugs. Same status, same body.
	it("answers an unknown vendor, an unknown customer, and a withheld customer identically", async () => {
		atHour("2026-08-01T04:00:00.000Z");
		const unknownVendor = await get("no-such-vendor", "acme-corp");
		atHour("2026-08-01T05:00:00.000Z");
		const unknownCustomer = await get("vantage", "no-such-customer");
		atHour("2026-08-01T06:00:00.000Z");
		const withheld = await get("vantage", "northwind");

		for (const res of [unknownVendor, unknownCustomer, withheld]) {
			expect(res.status).toBe(404);
		}

		const shape = (body: { error: string; detail: string }) => ({
			error: body.error,
			// The detail differs only by the slugs the caller itself supplied, so
			// normalise those out: what must not vary is anything WE know.
			detailTemplate: body.detail.replace(/"[^"]*"/, '"<slug>"'),
			keys: Object.keys(body).sort(),
		});

		const [a, b, c] = await Promise.all([unknownVendor.json(), unknownCustomer.json(), withheld.json()]);
		expect(shape(a)).toEqual(shape(b));
		expect(shape(b)).toEqual(shape(c));
		expect(a.error).toBe("not_found");
	});

	it("leaves a 404 uncacheable, so a withdrawal is not itself cached at the edge", async () => {
		atHour("2026-08-01T07:00:00.000Z");

		const res = await get("vantage", "northwind");

		expect(res.headers.get("cache-control")).toBeNull();
	});

	it("keeps a 404 CORS-open, so a cross-origin agent reads the refusal instead of a network error", async () => {
		atHour("2026-08-01T08:00:00.000Z");

		const res = await get("vantage", "northwind");

		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("x-letterprove")).toBe("on");
	});
});

describe("GET /attest/[vendor]/[customer] — cache headers", () => {
	it("caches a named document for only 60 seconds and forbids stale-while-revalidate", async () => {
		// This is the header that decides how long a withdrawn customer stays
		// readable. stale-while-revalidate on a named document authorises
		// serving a document the origin has already stopped publishing, which
		// is exactly the failure measured in production. If someone widens
		// either half of this, that is what breaks.
		atHour("2026-08-02T00:00:00.000Z");

		const res = await get("vantage", "acme-corp");

		const cacheControl = res.headers.get("cache-control");
		expect(cacheControl).toBe("public, max-age=60, must-revalidate");
		expect(cacheControl).not.toContain("stale-while-revalidate");
	});

	it("declares the charset, because a signature is over UTF-8 bytes", async () => {
		atHour("2026-08-02T01:00:00.000Z");

		const res = await get("vantage", "acme-corp");

		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});

describe("GET /attest/[vendor]/[customer] — the .json suffix", () => {
	it("serves the same document at customer and customer.json", async () => {
		// The README advertises the .json form, and plenty of fetchers cannot
		// set an Accept header. Both spellings must resolve to one customer.
		atHour("2026-08-03T00:00:00.000Z");

		const plain = await get("vantage", "acme-corp");
		const suffixed = await get("vantage", "acme-corp.json");

		expect(suffixed.status).toBe(200);
		expect(await suffixed.json()).toEqual(await plain.json());
	});

	it("does not let the suffix smuggle a withheld customer past the consent gate", async () => {
		atHour("2026-08-03T01:00:00.000Z");

		expect((await get("vantage", "northwind.json")).status).toBe(404);
	});

	it("strips the suffix once only, so a doubled suffix is not a customer", async () => {
		atHour("2026-08-03T02:00:00.000Z");

		expect((await get("vantage", "acme-corp.json.json")).status).toBe(404);
	});
});

describe("GET /attest/[vendor]/[customer] — access logging", () => {
	it("logs the stripped slug, so .json and plain fetches aggregate as one subject", async () => {
		atHour("2026-08-04T00:00:00.000Z");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await get("vantage", "acme-corp.json");

		const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[letterprove:access]"));
		expect(line).toBeDefined();
		expect(JSON.parse(line!.slice("[letterprove:access] ".length)).subject).toBe("vantage/acme-corp");
	});

	it("logs a withheld fetch too, since a refusal is still a read of the surface", async () => {
		atHour("2026-08-04T01:00:00.000Z");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await get("vantage", "northwind");

		expect(log.mock.calls.some((c) => String(c[0]).startsWith("[letterprove:access]"))).toBe(true);
	});
});
