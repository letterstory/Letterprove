import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

/**
 * Visitor identification end to end against the real schema: the tools write
 * the vendor row, /v1/config's pixel read follows it, and get_visitors pulls
 * through the tenant boundary. Maverick is the one thing mocked.
 */

let pg: PGlite;
const maverick = vi.hoisted(() => ({
	created: [] as { domain: string; clientRef?: string }[],
	deleted: [] as string[],
	existing: new Map<string, string>(),
	people: [] as unknown[],
}));

vi.mock("@/lib/db/client", () => ({ dbClient: () => pgliteSupabase(pg) }));
vi.mock("@/lib/maverick/client", async (orig) => {
	const real = await orig<typeof import("@/lib/maverick/client")>();
	return {
		...real,
		partnerCreateDomain: vi.fn(async (opts: { domain: string; clientRef?: string }) => {
			maverick.created.push(opts);
			const owner = maverick.existing.get(opts.domain);
			return {
				ok: true,
				data: {
					domain: opts.domain,
					existing: owner !== undefined,
					customerId: "1091",
					clientRef: owner ?? opts.clientRef ?? null,
					pixelSnippet: '<script data-customer-id="1091" data-profile-id="roxaObLRwvD"></script>',
				},
			};
		}),
		partnerDeleteDomain: vi.fn(async (domain: string) => {
			maverick.deleted.push(domain);
			return { ok: true, data: { success: true } };
		}),
		listPeople: vi.fn(async () => ({ ok: true, data: { data: maverick.people, pagination: { nextCursor: null } } })),
	};
});

const VERIFIED = randomUUID();
const UNVERIFIED = randomUUID();

function caller(vendorId: string): OAuthPrincipal {
	return { tokenId: "letterstory-service", vendorId, userId: "letterstory-service", capabilities: ["vendor:read", "vendor:write"], orgId: "e2e" };
}

async function vendor(id: string, slug: string, domain: string, verified: boolean) {
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verification_token, domain_verified_at)
		 values ($1, $2, $2, $3, 'test', $4, gen_random_uuid(), 'tok', $5)`,
		[id, slug, domain, `lp_live_${slug}`, verified ? new Date().toISOString() : null],
	);
}

beforeAll(async () => {
	pg = await bootstrapPglite();
	await vendor(VERIFIED, "acme", "acme.example", true);
	await vendor(UNVERIFIED, "nope", "nope.example", false);
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.stubEnv("MAVERICK_API_KEY", "mk_test");
	vi.stubEnv("MAVERICK_PARTNER_API_KEY", "pk_test");
	maverick.created.length = 0;
	maverick.deleted.length = 0;
	maverick.existing.clear();
	maverick.people = [];
	const { _resetVisitorCache } = await import("./visitors");
	_resetVisitorCache();
	await pg.query(`update vendors set visitor_identification_enabled = false, maverick_customer_id = null, maverick_profile_id = null, maverick_domains = '{}'`);
});

describe("visitor identification against a real schema", () => {
	it("is off by default, and config serves no pixel", async () => {
		const { visitorPixel } = await import("./visitors");
		expect(await visitorPixel(VERIFIED)).toBeNull();
	});

	it("turning it on registers the verified domain and serves the pixel", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const { visitorPixel } = await import("./visitors");
		const out = await dispatchTool("set_visitor_identification", { enabled: true }, caller(VERIFIED));
		expect(out).toMatchObject({
			kind: "result",
			result: { ok: true, body: { enabled: true, tracking: "active", registered_domains: ["acme.example"] } },
		});
		expect(maverick.created).toEqual([{ domain: "acme.example", clientRef: `letterprove:${VERIFIED}` }]);
		expect(await visitorPixel(VERIFIED)).toEqual({ customer_id: "1091", profile_id: "roxaObLRwvD" });
	});

	it("refuses a vendor with neither DNS nor site proof", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const out = await dispatchTool("set_visitor_identification", { enabled: true }, caller(UNVERIFIED));
		expect(out).toMatchObject({ kind: "result", result: { ok: false, status: 409, body: { error: "site_not_verified" } } });
		expect(maverick.created).toEqual([]);
	});

	it("accepts the site proof instead of DNS: the vendor's key found on its homepage", async () => {
		const SITE = randomUUID();
		await vendor(SITE, "sited", "sited.example", false);
		const { dispatchTool } = await import("@/lib/tools/registry");
		const { verifySite } = await import("./site-verify");
		const { visitorPixel } = await import("./visitors");

		// Not on the page yet: still refused, and nothing is registered.
		const missing = await verifySite(SITE, {
			lookup: async () => ["93.184.216.34"],
			fetcher: (async () => new Response("<html><head></head></html>", { status: 200 })) as unknown as typeof fetch,
		});
		expect(missing?.verified).toBe(false);
		const refused = await dispatchTool("set_visitor_identification", { enabled: true }, caller(SITE));
		expect(refused).toMatchObject({ kind: "result", result: { ok: false, status: 409, body: { error: "site_not_verified" } } });

		// The Visitors tag with its own key: proven, and People turns on.
		const found = await verifySite(SITE, {
			lookup: async () => ["93.184.216.34"],
			fetcher: (async () =>
				new Response('<script src="https://lettervisit.com/v.js" data-key="lp_live_sited"></script>', { status: 200 })) as unknown as typeof fetch,
		});
		expect(found).toMatchObject({ verified: true, checked_url: "https://sited.example/" });
		const on = await dispatchTool("set_visitor_identification", { enabled: true }, caller(SITE));
		expect(on).toMatchObject({ kind: "result", result: { ok: true, body: { enabled: true, tracking: "active" } } });
		expect(await visitorPixel(SITE)).toEqual({ customer_id: "1091", profile_id: "roxaObLRwvD" });

		// Losing the site proof stops the pixel at once.
		await pg.query(`update vendors set site_verified_at = null where id = $1`, [SITE]);
		expect(await visitorPixel(SITE)).toBeNull();
	});

	it("turning it off deactivates only what it registered, never a domain someone else already tracked", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const { visitorPixel } = await import("./visitors");
		maverick.existing.set("acme.example", "phantom-123");
		await dispatchTool("set_visitor_identification", { enabled: true }, caller(VERIFIED));
		const off = await dispatchTool("set_visitor_identification", { enabled: false }, caller(VERIFIED));
		expect(off).toMatchObject({ kind: "result", result: { ok: true, body: { enabled: false, tracking: "off" } } });
		expect(maverick.deleted).toEqual([]);
		expect(await visitorPixel(VERIFIED)).toBeNull();
	});

	it("deactivates its own registration on the way off", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		await dispatchTool("set_visitor_identification", { enabled: true }, caller(VERIFIED));
		await dispatchTool("set_visitor_identification", { enabled: false }, caller(VERIFIED));
		expect(maverick.deleted).toEqual(["acme.example"]);
	});

	it("is pending, not failed, when the partner key is missing", async () => {
		vi.stubEnv("MAVERICK_PARTNER_API_KEY", "");
		const { dispatchTool } = await import("@/lib/tools/registry");
		const out = await dispatchTool("set_visitor_identification", { enabled: true }, caller(VERIFIED));
		expect(out).toMatchObject({ kind: "result", result: { ok: true, body: { enabled: true, tracking: "pending_registration" } } });
	});

	it("get_visitors returns nothing while off, and only this vendor's people while on", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const recent = new Date(Date.now() - 86_400_000).toISOString();
		const p = (id: string, domain: string, company: string) => ({
			id,
			email: null,
			businessEmail: `${id}@${company}.example`,
			firstName: id,
			lastName: null,
			title: null,
			company,
			location: null,
			linkedinUrl: null,
			visitCount: 1,
			firstSeen: recent,
			lastSeen: recent,
			classifiedSeniority: null,
			classifiedJobFunction: null,
			companyData: { name: company, domain: `${company}.example` },
			domain,
			clientRef: null,
		});
		maverick.people = [p("a", "acme.example", "globex"), p("b", "other-vendor.example", "initech")];

		const off = await dispatchTool("get_visitors", {}, caller(VERIFIED));
		expect(off).toMatchObject({ kind: "result", result: { ok: true, body: { enabled: false, visitors: [], companies: [] } } });

		await dispatchTool("set_visitor_identification", { enabled: true }, caller(VERIFIED));
		const on = await dispatchTool("get_visitors", { limit: 10 }, caller(VERIFIED));
		expect(on).toMatchObject({
			kind: "result",
			result: {
				ok: true,
				body: {
					enabled: true,
					tracking: "active",
					total: 1,
					visitors: [{ person_id: "a", seen_on: "acme.example" }],
					companies: [{ company: "globex", domain: "globex.example", people: 1 }],
				},
			},
		});
	});

	it("shows the first 10 people in full and the rest as a locked count, until staff unlock", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const base = Date.now() - 5 * 86_400_000;
		// 12 people on acme, first seen one hour apart; p00 is the oldest.
		maverick.people = Array.from({ length: 12 }, (_, i) => {
			const id = `p${String(i).padStart(2, "0")}`;
			return {
				id,
				email: null,
				businessEmail: `${id}@co${i}.example`,
				firstName: id,
				lastName: null,
				title: null,
				company: `co${i}`,
				location: null,
				linkedinUrl: null,
				visitCount: 1,
				firstSeen: new Date(base + i * 3_600_000).toISOString(),
				lastSeen: new Date(Date.now() - 3_600_000).toISOString(),
				classifiedSeniority: null,
				classifiedJobFunction: null,
				companyData: { name: `co${i}`, domain: `co${i}.example` },
				domain: "acme.example",
				clientRef: null,
			};
		}).reverse();
		await dispatchTool("set_visitor_identification", { enabled: true }, caller(VERIFIED));

		const free = await dispatchTool("get_visitors", { limit: 200 }, caller(VERIFIED));
		const body = (free as { result: { body: Record<string, unknown> } }).result.body as {
			visitors: { person_id: string }[];
			companies: { company: string }[];
		};
		expect(body).toMatchObject({ total: 12, shown: 10, locked: 2, free_limit: 10, unlocked: false });
		expect(body.visitors.map((v) => v.person_id)).toEqual(["p00", "p01", "p02", "p03", "p04", "p05", "p06", "p07", "p08", "p09"]);
		// The locked two don't leak, not even as a company.
		expect(JSON.stringify(body)).not.toMatch(/p10|p11|co10|co11/);
		expect(body.companies).toHaveLength(10);

		// A vendor can't lift it for itself.
		const denied = await dispatchTool("set_visitor_identification_unlocked", { vendor: "acme", unlocked: true }, caller(VERIFIED));
		expect(denied).not.toMatchObject({ kind: "result", result: { ok: true } });

		await pg.query(`update vendors set visitor_identification_unlocked = true where id = $1`, [VERIFIED]);
		const { _resetVisitorCache } = await import("./visitors");
		_resetVisitorCache();
		const all = await dispatchTool("get_visitors", { limit: 200 }, caller(VERIFIED));
		expect(all).toMatchObject({ result: { body: { total: 12, shown: 12, locked: 0, unlocked: true } } });
		await pg.query(`update vendors set visitor_identification_unlocked = false where id = $1`, [VERIFIED]);
	});

	it("never puts visitor data into the attestation body", async () => {
		const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/attest/aggregate.ts", "utf8"));
		expect(src).not.toMatch(/visitor|maverick/i);
	});
});
