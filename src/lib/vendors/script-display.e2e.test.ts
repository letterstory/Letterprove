import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

/**
 * Scripts and proof display end to end against the real schema: get_script /
 * set_script_modules and get_proof_display / set_proof_display through the
 * dispatcher, and the proofs module actually stopping /v1/observe.
 */

let pg: PGlite;

vi.mock("@/lib/db/client", () => ({ dbClient: () => pgliteSupabase(pg) }));
vi.mock("@/lib/oauth/ratelimit", () => ({ oauthRateLimit: async () => true, oauthClientIp: () => "test" }));
vi.mock("@/lib/telemetry/record", () => ({ recordObservation: vi.fn(async () => undefined) }));

const VERIFIED = randomUUID();
const UNVERIFIED = randomUUID();
const ORIGIN = "https://app.letterprove.com";

function caller(vendorId: string): OAuthPrincipal {
	return { tokenId: "letterstory-service", vendorId, userId: "letterstory-service", capabilities: ["vendor:read", "vendor:write"], orgId: "e2e" };
}

async function vendor(id: string, slug: string, domain: string, verified: boolean) {
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verification_token, domain_verified_at)
		 values ($1, $2, $2, $3, 'test', $4, gen_random_uuid(), $5, $6)`,
		[id, slug, domain, `lp_live_${slug}`, `tok-${slug}`, verified ? new Date().toISOString() : null],
	);
}

async function tool(name: string, args: unknown, vendorId: string) {
	const { dispatchTool } = await import("@/lib/tools/registry");
	const out = await dispatchTool(name, args, caller(vendorId), { origin: ORIGIN });
	if (out.kind !== "result") throw new Error(`${name}: ${out.kind}`);
	return out.result;
}

beforeAll(async () => {
	pg = await bootstrapPglite();
	await vendor(VERIFIED, "ver", "ver.example", true);
	await vendor(UNVERIFIED, "unver", "unver.example", false);
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	const { _resetModuleMemo } = await import("@/lib/vendors/script");
	_resetModuleMemo();
});

describe("scripts", () => {
	it("returns the script with proofs and agent visitors on by default, human visitors off", async () => {
		const res = await tool("get_script", {}, VERIFIED);
		expect(res.ok).toBe(true);
		const body = res.body as Record<string, unknown>;
		expect(body.key).toBe("lp_live_ver");
		expect(String(body.snippet)).toContain("data-key=\"lp_live_ver\"");
		expect(body.modules).toEqual({ proofs: true, agent_visitors: true, human_visitors: false });
		expect(body.human_visitors_tracking).toBe("off");
		expect(body.status).toMatchObject({ script_seen_at: null, server_seen_at: null, first_signin_at: null, domain_verified: true });
	});

	it("turns modules on and off, and refuses human visitors before DNS proof", async () => {
		const off = await tool("set_script_modules", { proofs: false, agent_visitors: false }, VERIFIED);
		expect((off.body as { modules: unknown }).modules).toEqual({ proofs: false, agent_visitors: false, human_visitors: false });
		const back = await tool("set_script_modules", { proofs: true, agent_visitors: true }, VERIFIED);
		expect((back.body as { modules: unknown }).modules).toMatchObject({ proofs: true, agent_visitors: true });

		const refused = await tool("set_script_modules", { human_visitors: true }, UNVERIFIED);
		expect(refused).toMatchObject({ ok: false, status: 409, body: { error: "domain_not_verified" } });
	});

	it("stops counting sign-ins at once when the proofs module is off", async () => {
		const { recordObservation } = await import("@/lib/telemetry/record");
		const { POST } = await import("@/app/api/v1/observe/route");
		const send = () =>
			POST(
				new Request("https://app.letterprove.com/api/v1/observe", {
					method: "POST",
					headers: { origin: "https://ver.example" },
					body: JSON.stringify({ k: "lp_live_ver", domain: "globex.com", ev: "session", cfg: 1, ts: Math.floor(Date.now() / 1000) }),
				}),
			);
		await tool("set_script_modules", { proofs: false }, VERIFIED);
		vi.mocked(recordObservation).mockClear();
		expect((await send()).headers.get("x-letterprove")).toBe("off");
		expect(recordObservation).not.toHaveBeenCalled();
		await tool("set_script_modules", { proofs: true }, VERIFIED);
		expect((await send()).headers.get("x-letterprove")).toBe("on");
		expect(recordObservation).toHaveBeenCalledTimes(1);
	});
});

describe("proof display", () => {
	it("shows everything by default and lists what is always shown", async () => {
		const res = await tool("get_proof_display", {}, VERIFIED);
		expect(res.body).toEqual({
			sections: { sessions: true, reported_history: true, logos: true, payment_details: true, observed_since: true, hosts: true },
			locked: ["domain", "tier", "companies_observed", "verify"],
		});
	});

	it("hides only the sections passed, and never a locked item", async () => {
		const res = await tool("set_proof_display", { sections: { sessions: false, logos: false } }, VERIFIED);
		expect((res.body as { sections: Record<string, boolean> }).sections).toMatchObject({ sessions: false, logos: false, hosts: true });
		const locked = await tool("set_proof_display", { sections: { tier: false } }, VERIFIED);
		expect(locked).toMatchObject({ ok: false, status: 400, body: { error: "locked_section" } });
	});
});
