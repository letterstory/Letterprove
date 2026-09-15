import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * The vendor aggregate document.
 *
 * Unlike the per-customer routes this one names nobody, so the tests here are
 * about the other two things a published document has to get right: that it
 * never publishes a zero it did not measure, and that its cache window is the
 * long one it is allowed to have precisely BECAUSE nothing here is
 * withdrawable.
 *
 * `publishedVendorAggregate` is mocked at the module boundary — signing and chain
 * composition are covered exhaustively in lib/attest/aggregate.test.ts, and
 * repeating them here would test the library twice and the route not at all.
 */

vi.mock("@/lib/attest/aggregate", () => ({ publishedVendorAggregate: vi.fn() }));

import { publishedVendorAggregate } from "@/lib/attest/aggregate";

const AGGREGATE = {
	vendor: "vantage",
	kind: "aggregate" as const,
	window_days: 30,
	companies_observed: 12,
	sessions: 38_000,
	signups: 210,
	logins: 9_400,
	domains_excluded: 3,
	tier: 2 as const,
	observed_through: "2026-08-01T00:00:00.000Z",
	published_at: "2026-08-01T00:00:00.000Z",
	ttl: 3600,
	prev_hash: "00".repeat(32),
	method: "https://github.com/letterstory/Letterprove/blob/main/src/lib/attest/aggregate.ts",
	key_id: "dev-insecure-0000",
	signature: "sig",
};

function get(vendor: string) {
	return GET(new Request(`https://www.letterprove.com/attest/${vendor}`), {
		params: Promise.resolve({ vendor }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(publishedVendorAggregate).mockResolvedValue(AGGREGATE as never);
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("GET /attest/[vendor]", () => {
	it("serves the signed aggregate verbatim", async () => {
		const res = await get("vantage");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(AGGREGATE);
	});

	it("names nobody, which is what licenses this document to be public at all", async () => {
		const body = await (await get("vantage")).json();

		// Guard against the aggregate quietly growing a per-customer field. A
		// count of companies carries almost no consent problem; a list of them
		// is the thing that needs permission.
		expect(body).not.toHaveProperty("customer");
		expect(body).not.toHaveProperty("customer_name");
		expect(body).not.toHaveProperty("customers");
		expect(JSON.stringify(body)).not.toContain("customer_name");
	});

	it("404s an unknown vendor rather than publishing a signed zero", async () => {
		// publishedVendorAggregate returns null for an unknown vendor, an
		// unpublished one, and telemetry
		// it could not read. Neither may publish as "0 companies observed": a
		// signed zero is a claim, and a wrong one.
		vi.mocked(publishedVendorAggregate).mockResolvedValue(null);

		const res = await get("no-such-vendor");

		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("not_found");
		expect(body).not.toHaveProperty("companies_observed");
	});

	it("keeps the 404 CORS-open and uncacheable", async () => {
		vi.mocked(publishedVendorAggregate).mockResolvedValue(null);

		const res = await get("no-such-vendor");

		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("cache-control")).toBeNull();
	});
});

describe("GET /attest/[vendor] — cache headers", () => {
	it("caches for the document's OWN ttl, not a constant", async () => {
		// The ttl is signed into the body. If the header and the body disagreed,
		// a verifier reading `ttl` would be told one staleness bound while the
		// edge enforced another.
		vi.mocked(publishedVendorAggregate).mockResolvedValue({ ...AGGREGATE, ttl: 900 } as never);

		const res = await get("vantage");

		expect(res.headers.get("cache-control")).toBe("public, max-age=900, stale-while-revalidate=86400");
	});

	it("allows stale-while-revalidate, which the named routes must not", async () => {
		// Deliberate and safe here only because there is nothing in this
		// document a customer can withdraw. Serving a slightly old signed
		// snapshot beats a failed fetch, and `observed_through` makes the
		// staleness self-describing.
		const res = await get("vantage");

		expect(res.headers.get("cache-control")).toContain("stale-while-revalidate=86400");
	});

	it("declares the charset, because a signature is over UTF-8 bytes", async () => {
		const res = await get("vantage");

		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("x-letterprove")).toBe("on");
	});
});

describe("GET /attest/[vendor] — the .json suffix", () => {
	it("serves the same document at vendor and vendor.json", async () => {
		const plain = await get("vantage");
		const suffixed = await get("vantage.json");

		expect(suffixed.status).toBe(200);
		expect(await suffixed.json()).toEqual(await plain.json());
		expect(publishedVendorAggregate).toHaveBeenNthCalledWith(1, "vantage");
		expect(publishedVendorAggregate).toHaveBeenNthCalledWith(2, "vantage");
	});

	it("strips the suffix once only", async () => {
		await get("vantage.json.json");

		expect(publishedVendorAggregate).toHaveBeenCalledWith("vantage.json");
	});

	it("leaves a slug that merely contains .json alone", async () => {
		await get("jsonhero");

		expect(publishedVendorAggregate).toHaveBeenCalledWith("jsonhero");
	});
});

describe("GET /attest/[vendor] — access logging", () => {
	it("logs the stripped slug under an /aggregate subject", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await get("vantage.json");

		const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[letterprove:access]"));
		expect(JSON.parse(line!.slice("[letterprove:access] ".length)).subject).toBe("vantage/aggregate");
	});

	it("classifies an agent fetch without keeping the user-agent string", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await GET(
			new Request("https://www.letterprove.com/attest/vantage", {
				headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" },
			}),
			{ params: Promise.resolve({ vendor: "vantage" }) }
		);

		const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[letterprove:access]"))!;
		expect(line).not.toContain("Mozilla");
		expect(JSON.parse(line.slice("[letterprove:access] ".length)).kind).toBe("ai_agent");
	});
});
