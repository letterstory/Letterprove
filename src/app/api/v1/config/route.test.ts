import { beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_CONFIG_VERSION } from "@/lib/telemetry/events";
import { GET } from "./route";

/**
 * `GET /v1/config` — the first request attest.js makes on a vendor's page.
 *
 * Two properties matter and neither is about the body: it must fail CLOSED on
 * a key it does not recognise, and a failure must not be cacheable, because a
 * vendor who fixes a mistyped key should not have to wait out a cached 404 on
 * every one of their visitors.
 */

vi.mock("@/lib/fixtures/vendors", () => ({ findVendorByKey: vi.fn() }));
vi.mock("@/lib/telemetry/ping", () => ({ recordConfigPing: vi.fn() }));

import { findVendorByKey } from "@/lib/fixtures/vendors";
import { recordConfigPing } from "@/lib/telemetry/ping";

const VENDOR = {
	id: "00000000-0000-0000-0000-000000000001",
	slug: "vantage",
	name: "Vantage",
	domain: "vantage.example",
	category: "customer data platforms",
	key: "lp_live_vantage_9f2c",
	domainVerified: true,
	customers: [],
};

function get(query: string) {
	return GET(new Request(`https://www.letterprove.com/api/v1/config${query}`));
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(findVendorByKey).mockResolvedValue(VENDOR as never);
	vi.mocked(recordConfigPing).mockResolvedValue(undefined);
});

describe("GET /v1/config", () => {
	it("answers a known key with the current config version", async () => {
		const res = await get("?k=lp_live_vantage_9f2c");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ cfg: CURRENT_CONFIG_VERSION, signals: [] });
		expect(findVendorByKey).toHaveBeenCalledWith("lp_live_vantage_9f2c");
	});

	it("ships signals as an empty array rather than omitting the field", async () => {
		// Reserved for phase-2 named/feature events. Present-and-empty now so
		// that phase is not a breaking response-shape change for every script
		// already deployed on a vendor's page.
		const body = await (await get("?k=lp_live_vantage_9f2c")).json();

		expect(body.signals).toEqual([]);
		expect(Array.isArray(body.signals)).toBe(true);
	});

	it("never echoes the key back, so a config response is not a key oracle", async () => {
		const res = await get("?k=lp_live_vantage_9f2c");
		const text = await res.text();

		expect(text).not.toContain("lp_live_vantage_9f2c");
		// Nor the vendor's identity: the script already knows who it is, and
		// this endpoint is unauthenticated.
		expect(text).not.toContain("vantage");
	});
});

describe("GET /v1/config — failing closed", () => {
	it("404s an unknown key instead of guessing a config", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue(undefined as never);

		const res = await get("?k=lp_live_nope");

		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("not_found");
	});

	it("404s a missing k without even attempting a lookup", async () => {
		const res = await get("");

		expect(res.status).toBe(404);
		expect(findVendorByKey).not.toHaveBeenCalled();
	});

	it("404s an empty k, since the empty string is not a key", async () => {
		const res = await get("?k=");

		expect(res.status).toBe(404);
		expect(findVendorByKey).not.toHaveBeenCalled();
	});

	it("leaves a 404 with no cache-control, so fixing a mistyped key takes effect at once", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue(undefined as never);

		const res = await get("?k=lp_live_typo");

		expect(res.headers.get("cache-control")).toBeNull();
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	it("records no ping for a key it could not resolve", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue(undefined as never);

		await get("?k=lp_live_nope");

		expect(recordConfigPing).not.toHaveBeenCalled();
	});
});

describe("GET /v1/config — cache headers", () => {
	it("caches a success for five minutes with an hour of stale-while-revalidate", async () => {
		// This is how fast a signals change reaches an already-loaded vendor
		// page, and also why lib/telemetry/ping.ts warns that `last_seen` is
		// coarser than it looks: a cache hit never reaches this handler.
		const res = await get("?k=lp_live_vantage_9f2c");

		expect(res.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
	});

	it("stays CORS-open, because the script fetches this from the vendor's origin", async () => {
		const res = await get("?k=lp_live_vantage_9f2c");

		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(res.headers.get("x-letterprove")).toBe("on");
	});
});

describe("GET /v1/config — the install ping", () => {
	it("records the ping against the vendor's slug, not the key", async () => {
		await get("?k=lp_live_vantage_9f2c");

		expect(recordConfigPing).toHaveBeenCalledWith("vantage");
	});

	// PINNED AS-IS, AND IT IS THE ONE THING HERE I WOULD CHANGE. The route
	// awaits recordConfigPing with no guard of its own, so config delivery
	// currently depends entirely on that function's internal try/catch never
	// being removed. Today it cannot reject, which is why this is not a live
	// bug and is not fixed in a test-only change — but "a vendor's script stops
	// booting because our telemetry table is unhappy" is one refactor away, and
	// every other never-break-the-caller path in this repo guards at the call
	// site too. Flip this test and wrap the await when someone agrees.
	it("propagates a ping rejection to the caller, rather than serving config anyway", async () => {
		vi.mocked(recordConfigPing).mockRejectedValue(new Error("db down"));

		await expect(get("?k=lp_live_vantage_9f2c")).rejects.toThrow("db down");
	});

	it("serves the config after a ping that resolves slowly", async () => {
		let release: () => void = () => {};
		vi.mocked(recordConfigPing).mockReturnValue(new Promise<void>((r) => (release = r)));

		const pending = get("?k=lp_live_vantage_9f2c");
		release();

		expect((await pending).status).toBe(200);
	});
});
