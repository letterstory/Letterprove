import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

/**
 * Agent visits end to end against the real schema: POST /api/v1/agent-visit
 * in both modes writes through record_agent_visit, and get_agent_visits reads
 * it back. The operators' published range lists are the one thing mocked —
 * one address counts as "from the operator", every other doesn't — so no test
 * touches the network.
 */

let pg: PGlite;
const OPERATOR_IP = "20.171.0.1";

vi.mock("@/lib/db/client", () => ({ dbClient: () => pgliteSupabase(pg) }));
vi.mock("@/lib/oauth/ratelimit", () => ({ oauthRateLimit: async () => true, oauthClientIp: () => "test" }));
vi.mock("@/lib/access/verify-agent", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/access/verify-agent")>();
	return { ...real, isVerifiedAgent: async (name: string, ip: string | null) => name !== "automated_browser" && ip === OPERATOR_IP };
});

const ACME = randomUUID();
const UNVERIFIED = randomUUID();
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

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

async function post(body: unknown, headers: Record<string, string> = {}) {
	const { POST } = await import("@/app/api/v1/agent-visit/route");
	return POST(new Request("https://app.letterprove.com/api/v1/agent-visit", { method: "POST", body: JSON.stringify(body), headers }));
}

async function rows() {
	const { rows } = await pg.query<{ vendor_id: string; agent: string; kind: string; verified: boolean; path: string; count: number }>(
		"select vendor_id, agent, kind, verified, path, count from vendor_agent_visits order by agent, path",
	);
	return rows;
}

beforeAll(async () => {
	pg = await bootstrapPglite();
	await vendor(ACME, "acme", "acme.example", true);
	await vendor(UNVERIFIED, "unv", "unv.example", false);
	await pg.query(`insert into vendor_hosts (vendor_id, host, proof, verified_at) values ($1, 'www.acme.example', 'under_verified_domain', now())`, [ACME]);
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	await pg.query("delete from vendor_agent_visits");
});

describe("POST /api/v1/agent-visit — server mode", () => {
	it("counts a verified agent and folds repeats into one daily row", async () => {
		const visit = { k: "lp_live_acme", ua: "Mozilla/5.0; compatible; GPTBot/1.2", ip: OPERATOR_IP, path: "/pricing?ref=x" };
		const res = await post(visit);
		expect(res.status).toBe(204);
		expect(res.headers.get("x-letterprove")).toBe("on");
		await post(visit);
		expect(await rows()).toEqual([{ vendor_id: ACME, agent: "chatgpt", kind: "ai_agent", verified: true, path: "/pricing", count: 2 }]);
	});

	it("stores a user-agent claim from the wrong address as claimed, not verified", async () => {
		await post({ k: "lp_live_acme", ua: "Claude-User/1.0", ip: "203.0.113.9", path: "/" });
		expect(await rows()).toMatchObject([{ agent: "claude", verified: false }]);
	});

	it("drops browsers before anything is written", async () => {
		const res = await post({ k: "lp_live_acme", ua: CHROME, ip: OPERATOR_IP, path: "/" });
		expect(res.status).toBe(204);
		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(await rows()).toEqual([]);
	});

	it("accepts the vendor's extra hosts and refuses hosts that aren't theirs", async () => {
		await post({ k: "lp_live_acme", ua: "Googlebot/2.1", path: "/a", host: "www.acme.example" });
		const refused = await post({ k: "lp_live_acme", ua: "Googlebot/2.1", path: "/b", host: "rival.example" });
		expect(refused.headers.get("x-letterprove")).toBe("off");
		expect(await rows()).toMatchObject([{ agent: "google", kind: "search_crawler", path: "/a" }]);
	});

	it("counts agents before DNS proof, but only on the vendor's own domain and hosts beneath it", async () => {
		// Private analytics, never evidence: a new vendor sees agents on day one.
		expect((await post({ k: "lp_live_unv", ua: "GPTBot/1.2", path: "/" })).headers.get("x-letterprove")).toBe("on");
		expect((await post({ k: "lp_live_unv", ua: "GPTBot/1.2", path: "/a", host: "app.unv.example" })).headers.get("x-letterprove")).toBe("on");
		// A sibling host needs the DNS proof the vendor doesn't have yet.
		expect((await post({ k: "lp_live_unv", ua: "GPTBot/1.2", path: "/b", host: "unv-app.example" })).headers.get("x-letterprove")).toBe("off");
		expect((await post({ k: "lp_live_unv", ua: "GPTBot/1.2", path: "/c", host: "rival.example" })).headers.get("x-letterprove")).toBe("off");
		expect((await rows()).map((r) => r.path).sort()).toEqual(["/", "/a"]);
	});

	it("collects nothing for an unknown key", async () => {
		expect((await post({ k: "lp_live_nobody", ua: "GPTBot/1.2", path: "/" })).headers.get("x-letterprove")).toBe("off");
		expect(await rows()).toEqual([]);
	});

	it("stamps server_seen_at on the first forward of any kind, even a browser", async () => {
		// A vendor this suite hasn't posted for yet, so nothing has stamped it.
		const fresh = randomUUID();
		await vendor(fresh, "srv", "srv.example", false);
		await post({ k: "lp_live_srv", ua: CHROME, path: "/" });
		const { rows: seen } = await pg.query<{ server_seen_at: string | null }>("select server_seen_at from vendors where id = $1", [fresh]);
		expect(seen[0].server_seen_at).not.toBeNull();
		expect(await rows()).toEqual([]);
	});

	it("drops agent visits when the vendor turned the agent visitors module off", async () => {
		const { _resetModuleMemo } = await import("@/lib/vendors/script");
		await pg.query("update vendors set module_agent_visitors = false where id = $1", [ACME]);
		_resetModuleMemo();
		expect((await post({ k: "lp_live_acme", ua: "GPTBot/1.2", path: "/" })).headers.get("x-letterprove")).toBe("off");
		await pg.query("update vendors set module_agent_visitors = true where id = $1", [ACME]);
		_resetModuleMemo();
		expect(await rows()).toEqual([]);
	});
});

describe("POST /api/v1/agent-visit — client mode (attest.js)", () => {
	it("reads the visitor from the request's own headers and the host from Origin", async () => {
		await post(
			{ k: "lp_live_acme", path: "/docs", client: true, webdriver: true, ua: "GPTBot/1.2" },
			{ "user-agent": CHROME, origin: "https://acme.example", "x-vercel-forwarded-for": OPERATOR_IP },
		);
		// The body's `ua` is ignored in client mode: the browser's own header says Chrome.
		expect(await rows()).toMatchObject([{ agent: "automated_browser", kind: "automated_browser", verified: false, path: "/docs" }]);
	});

	it("recognises ChatGPT's agent by Signature-Agent", async () => {
		await post(
			{ k: "lp_live_acme", path: "/", client: true },
			{ "user-agent": CHROME, origin: "https://acme.example", "signature-agent": '"https://chatgpt.com"' },
		);
		expect(await rows()).toMatchObject([{ agent: "chatgpt", kind: "ai_agent" }]);
	});

	it("refuses a page on someone else's site", async () => {
		const res = await post({ k: "lp_live_acme", path: "/", client: true, webdriver: true }, { "user-agent": CHROME, origin: "https://rival.example" });
		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(await rows()).toEqual([]);
	});
});

describe("get_agent_visits", () => {
	it("totals per agent, verified vs claimed, top paths and a daily series — for the caller's vendor only", async () => {
		await post({ k: "lp_live_acme", ua: "GPTBot/1.2", ip: OPERATOR_IP, path: "/pricing" });
		await post({ k: "lp_live_acme", ua: "GPTBot/1.2", ip: "203.0.113.9", path: "/pricing" });
		await post({ k: "lp_live_acme", ua: "PerplexityBot/1.0", ip: OPERATOR_IP, path: "/docs" });

		const { dispatchTool } = await import("@/lib/tools/registry");
		const outcome = await dispatchTool("get_agent_visits", { days: 7 }, caller(ACME));
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error(JSON.stringify(outcome));
		const body = outcome.result.body as {
			total: number;
			verified: number;
			agents: { agent: string; total: number; verified: number; claimed: number }[];
			top_paths: { path: string; total: number }[];
			daily: { day: string; total: number; verified: number }[];
		};
		expect(body.total).toBe(3);
		expect(body.verified).toBe(2);
		expect(body.agents.map(({ agent, total, verified, claimed }) => ({ agent, total, verified, claimed }))).toEqual([
			{ agent: "chatgpt", total: 2, verified: 1, claimed: 1 },
			{ agent: "perplexity", total: 1, verified: 1, claimed: 0 },
		]);
		expect(body.top_paths).toEqual([
			{ path: "/pricing", total: 2 },
			{ path: "/docs", total: 1 },
		]);
		expect(body.daily).toEqual([{ day: new Date().toISOString().slice(0, 10), total: 3, verified: 2 }]);

		const other = await dispatchTool("get_agent_visits", {}, caller(UNVERIFIED));
		if (other.kind !== "result" || !other.result.ok) throw new Error(JSON.stringify(other));
		expect((other.result.body as { total: number }).total).toBe(0);
	});

	it("refuses an out-of-range window", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const outcome = await dispatchTool("get_agent_visits", { days: 365 }, caller(ACME));
		expect(outcome).toMatchObject({ kind: "result", result: { ok: false, status: 400 } });
	});
});
