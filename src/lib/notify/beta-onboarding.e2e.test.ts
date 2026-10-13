import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";

/**
 * The setup and breakage signals end to end against the real schema:
 * hosts beneath the verified domain are accepted, a dropped origin is counted
 * and reported by get_status, the first event is stamped, and incident emails
 * go out once per incident.
 */

let pg: PGlite;

vi.mock("@/lib/db/client", () => ({ dbClient: () => pgliteSupabase(pg) }));
vi.mock("@/lib/oauth/ratelimit", () => ({ oauthRateLimit: async () => true, oauthClientIp: () => "test" }));

const ACME = randomUUID();

beforeAll(async () => {
	pg = await bootstrapPglite();
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verification_token, domain_verified_at, contact_email)
		 values ($1, 'acme', 'Acme', 'app.acme.com', 'test', 'lp_live_acme', gen_random_uuid(), 'tok', now(), 'ops@acme.com')`,
		[ACME],
	);
}, 60_000);

afterAll(async () => {
	await pg?.close();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function observe(origin: string) {
	const { POST } = await import("@/app/api/v1/observe/route");
	return POST(
		new Request("https://app.letterprove.com/api/v1/observe", {
			method: "POST",
			headers: { origin },
			body: JSON.stringify({ k: "lp_live_acme", domain: "globex.com", ev: "session", cfg: 1, ts: 1754870400 }),
		}),
	);
}

describe("collection during setup", () => {
	it("accepts a host beneath the verified domain, counts a sibling it drops, and stamps the first event", async () => {
		expect((await observe("https://eu.app.acme.com")).headers.get("x-letterprove")).not.toBe("off");
		expect((await observe("https://www.acme.com")).headers.get("x-letterprove")).toBe("off");
		expect((await observe("https://www.acme.com")).headers.get("x-letterprove")).toBe("off");
		expect((await observe("http://localhost:3000")).headers.get("x-letterprove")).toBe("off");
		await new Promise((r) => setTimeout(r, 20));

		const { getVendorStatus } = await import("@/lib/vendors/status");
		const status = await getVendorStatus(ACME);
		if (!status.ok) throw new Error("status failed");
		expect(status.everReceivedAt).not.toBeNull();
		expect(status.rejectedOrigins).toEqual([
			expect.objectContaining({ host: "www.acme.com", events_24h: 2, addable: true, reason: "needs_proof" }),
			expect.objectContaining({ host: "localhost", events_24h: 1, addable: false, reason: "development" }),
		]);
	});
});

describe("incident emails", () => {
	it("emails once per incident, and releases the claim when the send fails", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const { notifyVendor } = await import("./vendor-email");
		const failing = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
		const ok = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

		expect(await notifyVendor(ACME, "dns_lost", "app.acme.com@2026-10-13", { fetcher: failing })).toBe("failed");
		expect(await notifyVendor(ACME, "dns_lost", "app.acme.com@2026-10-13", { fetcher: ok })).toBe("sent");
		expect(await notifyVendor(ACME, "dns_lost", "app.acme.com@2026-10-13", { fetcher: ok })).toBe("duplicate");
		expect(ok).toHaveBeenCalledTimes(1);
		const body = JSON.parse(((ok as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string);
		expect(body.to).toEqual(["ops@acme.com"]);
		expect(body.subject).toContain("app.acme.com");
	});

	it("sends nothing and claims nothing without a Resend key", async () => {
		vi.stubEnv("RESEND_API_KEY", "");
		const { notifyVendor } = await import("./vendor-email");
		expect(await notifyVendor(ACME, "stripe_failing", "streak@x")).toBe("not_configured");
		const { rows } = await pg.query("select 1 from vendor_notifications where kind = 'stripe_failing'");
		expect(rows).toHaveLength(0);
	});

	it("tells a vendor whose collection went quiet for two days, once", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const sent = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", sent);
		const quietId = randomUUID();
		await pg.query(
			`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verification_token, domain_verified_at, contact_email, first_event_at)
			 values ($1, 'quiet', 'Quiet', 'quiet.io', 'test', 'lp_live_quiet', gen_random_uuid(), 'tok', now(), 'me@quiet.io', now() - interval '3 days')`,
			[quietId],
		);
		const { notifyQuietVendors } = await import("./quiet-collection");
		expect((await notifyQuietVendors()).notified).toContain("quiet");
		expect((await notifyQuietVendors()).notified).not.toContain("quiet");
		expect(sent).toHaveBeenCalledTimes(1);
	});
});
