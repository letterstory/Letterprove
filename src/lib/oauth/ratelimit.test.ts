import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ratelimit.ts had zero test coverage before this file, and its most
 * consequential line — failing OPEN on a Postgres error, not just on a
 * missing datastore — is entirely undocumented behavior outside the code
 * comment (Casey's audit named this a live abuse-protection gap worth an
 * explicit red/green test rather than a known issue). This is deliberately a
 * PINNING test: it proves the current, chosen behavior, not a proposal to
 * change it — reversing it is a product/security tradeoff, not a bug fix.
 */

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

import { dbClient } from "@/lib/db/client";
import { oauthClientIp, oauthRateLimit } from "./ratelimit";

function fakeDb(rpc: ReturnType<typeof vi.fn>) {
	return { rpc } as unknown as ReturnType<typeof dbClient>;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("oauthRateLimit", () => {
	it("fails open when no datastore is configured at all", async () => {
		vi.mocked(dbClient).mockReturnValue(null);

		const allowed = await oauthRateLimit("bucket:x", 60, 10);

		expect(allowed).toBe(true);
	});

	it("allows the request when the bucket function reports under-limit", async () => {
		const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
		vi.mocked(dbClient).mockReturnValue(fakeDb(rpc));

		const allowed = await oauthRateLimit("bucket:x", 60, 10);

		expect(allowed).toBe(true);
	});

	it("denies the request when the bucket function reports over-limit", async () => {
		const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
		vi.mocked(dbClient).mockReturnValue(fakeDb(rpc));

		const allowed = await oauthRateLimit("bucket:x", 60, 10);

		expect(allowed).toBe(false);
	});

	// PINNED, NOT ENDORSED. This is the deliberate tradeoff the code comment
	// names: a transient DB blip must not lock everyone out, so a real
	// Postgres error is treated identically to "under limit" rather than
	// "over limit". It also means a sustained outage against oauth_rate_touch
	// removes this backstop entirely for as long as the outage lasts — that
	// residual is accepted, not hidden, and this test exists so a future
	// change to it is a deliberate diff against this assertion, not a silent
	// regression.
	it("fails open on a real Postgres error from the rate-touch function", async () => {
		const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "connection reset" } });
		vi.mocked(dbClient).mockReturnValue(fakeDb(rpc));

		const allowed = await oauthRateLimit("bucket:x", 60, 10);

		expect(allowed).toBe(true);
	});

	it("calls oauth_rate_touch with the bucket, window, and limit as given", async () => {
		const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
		vi.mocked(dbClient).mockReturnValue(fakeDb(rpc));

		await oauthRateLimit("observe:vendor:acme", 60, 3000);

		expect(rpc).toHaveBeenCalledWith("oauth_rate_touch", {
			p_bucket: "observe:vendor:acme",
			p_window_seconds: 60,
			p_limit: 3000,
		});
	});
});

describe("oauthClientIp", () => {
	function req(headers: Record<string, string>) {
		return new Request("https://app.letterprove.com/api/v1/observe", { headers });
	}

	it("takes the first address from x-forwarded-for", () => {
		expect(oauthClientIp(req({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
	});

	it("trims whitespace around the first x-forwarded-for entry", () => {
		expect(oauthClientIp(req({ "x-forwarded-for": "  203.0.113.9  , 10.0.0.1" }))).toBe("203.0.113.9");
	});

	it("falls back to x-real-ip when x-forwarded-for is absent", () => {
		expect(oauthClientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
	});

	it("falls back to 'unknown' when neither header is present", () => {
		expect(oauthClientIp(req({}))).toBe("unknown");
	});
});
