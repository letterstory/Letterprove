import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";

/**
 * observe/route.test.ts mocks findVendorByKey and recordObservation entirely
 * — it proves the route calls the right functions with the right shape, not
 * that the domain-verification refusal (the "load-bearing" check per
 * SetupSteps.tsx's own comment, and the test plan's A2 negative) actually
 * holds against the real `vendors.domain_verified_at` column, or that an
 * accepted event actually lands a real row in `hot_events`. This drives the
 * real POST handler, real findVendorByKey, and real recordObservation
 * against a real (embedded, WASM) Postgres with the actual migrations
 * applied — same technique as the other *.e2e.test.ts files in this repo.
 *
 * Rate limiting is deliberately mocked out here (it has its own coverage in
 * oauth/ratelimit.test.ts and observe/route.test.ts) so this file stays
 * focused on the one thing nothing else proves against the real schema: the
 * domain-verification gate.
 */

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/oauth/ratelimit", () => ({ oauthRateLimit: vi.fn().mockResolvedValue(true), oauthClientIp: vi.fn(() => "203.0.113.9") }));

let pg: PGlite;

const VERIFIED_VENDOR_ID = "44444444-4444-4444-4444-444444444444";
const UNVERIFIED_VENDOR_ID = "55555555-5555-5555-5555-555555555555";

beforeAll(async () => {
	pg = await bootstrapPglite();

	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verified_at)
		 values ($1, 'e2e-observe-verified', 'E2E Observe Verified', 'observe-verified.example', 'test', 'lp_live_e2e_observe_verified', gen_random_uuid(), now())`,
		[VERIFIED_VENDOR_ID],
	);
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verified_at)
		 values ($1, 'e2e-observe-unverified', 'E2E Observe Unverified', 'observe-unverified.example', 'test', 'lp_live_e2e_observe_unverified', gen_random_uuid(), null)`,
		[UNVERIFIED_VENDOR_ID],
	);
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase(pg) as never);
	const { oauthRateLimit } = await import("@/lib/oauth/ratelimit");
	vi.mocked(oauthRateLimit).mockResolvedValue(true);
});

async function hotEventCount(vendorSlug: string): Promise<number> {
	const { rows } = await pg.query<{ count: string }>("select count(*) from hot_events where vendor_slug = $1", [
		vendorSlug,
	]);
	return Number(rows[0].count);
}

async function post(key: string, domain: string, origin: string) {
	const { POST } = await import("./route");
	return POST(
		new Request("https://app.letterprove.com/api/v1/observe", {
			method: "POST",
			headers: { "content-type": "text/plain", origin },
			body: JSON.stringify({ k: key, domain, ev: "session", cfg: 1, ts: Math.floor(Date.now() / 1000) }),
		}),
	);
}

describe("POST /api/v1/observe against a real Postgres schema", () => {
	it("refuses an event for a vendor who has not proven domain control, and writes nothing", async () => {
		const res = await post("lp_live_e2e_observe_unverified", "acme.com", "https://observe-unverified.example");

		expect(res.status).toBe(204);
		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(await hotEventCount("e2e-observe-unverified")).toBe(0);
	});

	it("accepts and records a real row once the same vendor is verified", async () => {
		const res = await post("lp_live_e2e_observe_verified", "acme.com", "https://observe-verified.example");

		expect(res.status).toBe(204);
		expect(res.headers.get("x-letterprove")).toBe("on");
		expect(await hotEventCount("e2e-observe-verified")).toBe(1);

		const { rows } = await pg.query<{ domain: string; ev: string }>(
			"select domain, ev from hot_events where vendor_slug = $1",
			["e2e-observe-verified"],
		);
		expect(rows[0]).toMatchObject({ domain: "acme.com", ev: "session" });
	});
});
