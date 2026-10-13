import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

/**
 * Extra hosts end to end against the real schema: the tools write
 * vendor_hosts, acceptedHosts reads what /v1/observe trusts, and the daily
 * re-check clears an own-DNS host whose record is gone. DNS is the one thing
 * mocked, so no test touches the network.
 */

let pg: PGlite;
const dnsRecords: Record<string, string[]> = {};

vi.mock("@/lib/db/client", () => ({ dbClient: () => pgliteSupabase(pg) }));
vi.mock("node:dns", () => ({
	promises: {
		resolveTxt: async (host: string) => {
			if (!(host in dnsRecords)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
			return dnsRecords[host].map((r) => [r]);
		},
	},
}));

const ACME = randomUUID();
const SUBV = randomUUID();
const OTHER = randomUUID();
const RECORD = "letterprove-site-verification=tok-sub";

function caller(vendorId: string): OAuthPrincipal {
	return { tokenId: "letterstory-service", vendorId, userId: "letterstory-service", capabilities: ["vendor:read", "vendor:write"], orgId: "e2e" };
}

async function vendor(id: string, slug: string, domain: string, token: string, verified = true) {
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verification_token, domain_verified_at)
		 values ($1, $2, $2, $3, 'test', $4, gen_random_uuid(), $5, $6)`,
		[id, slug, domain, `lp_live_${slug}`, token, verified ? new Date().toISOString() : null],
	);
}

beforeAll(async () => {
	pg = await bootstrapPglite();
	await vendor(ACME, "acme", "acme.example", "tok-acme");
	await vendor(SUBV, "subv", "app.subv.example", "tok-sub");
	await vendor(OTHER, "other", "other.example", "tok-other");
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	for (const k of Object.keys(dnsRecords)) delete dnsRecords[k];
	const { forgetAcceptedHosts } = await import("./hosts");
	for (const id of [ACME, SUBV, OTHER]) forgetAcceptedHosts(id);
});

describe("extra hosts against a real schema", () => {
	it("accepts a host under the verified domain at once, and observe trusts it", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const { acceptedHosts } = await import("./hosts");
		const out = await dispatchTool("add_host", { host: "app.acme.example" }, caller(ACME));
		expect(out).toMatchObject({ kind: "result", result: { ok: true, body: { host: "app.acme.example", proof: "under_verified_domain", accepted: true } } });
		expect([...(await acceptedHosts(ACME))]).toEqual(["app.acme.example"]);
	});

	it("holds a sibling of a verified subdomain until its own record exists", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const { acceptedHosts, forgetAcceptedHosts } = await import("./hosts");

		const waiting = await dispatchTool("add_host", { host: "eu.subv.example" }, caller(SUBV));
		expect(waiting).toMatchObject({ result: { ok: true, body: { proof: "own_dns", accepted: false, record: RECORD } } });
		expect((await acceptedHosts(SUBV)).has("eu.subv.example")).toBe(false);

		dnsRecords["_letterprove.eu.subv.example"] = [RECORD];
		const done = await dispatchTool("add_host", { host: "eu.subv.example" }, caller(SUBV));
		expect(done).toMatchObject({ result: { ok: true, body: { accepted: true } } });
		forgetAcceptedHosts(SUBV);
		expect((await acceptedHosts(SUBV)).has("eu.subv.example")).toBe(true);
	});

	it("refuses another vendor's host and another company's domain", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		await dispatchTool("add_host", { host: "www.acme.example" }, caller(ACME));
		expect(await dispatchTool("add_host", { host: "www.acme.example" }, caller(OTHER))).toMatchObject({
			result: { ok: false, body: { error: "domain_not_yours" } },
		});
		expect(await dispatchTool("add_host", { host: "app.other.example" }, caller(ACME))).toMatchObject({
			result: { ok: false, body: { error: "domain_not_yours" } },
		});
	});

	it("lists and removes", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		await dispatchTool("add_host", { host: "docs.acme.example" }, caller(ACME));
		const listed = await dispatchTool("list_hosts", {}, caller(ACME));
		expect(listed).toMatchObject({ result: { ok: true, body: { domain: "acme.example" } } });
		const hosts = (listed as { result: { body: { hosts: { host: string }[] } } }).result.body.hosts.map((h) => h.host);
		expect(hosts).toContain("docs.acme.example");
		expect(await dispatchTool("remove_host", { host: "docs.acme.example" }, caller(ACME))).toMatchObject({ result: { ok: true, body: { removed: true } } });
		expect(await dispatchTool("remove_host", { host: "docs.acme.example" }, caller(ACME))).toMatchObject({ result: { ok: true, body: { removed: false } } });
	});

	it("drops every host when the vendor changes its domain", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		await dispatchTool("update_vendor", { domain: "newname.example" }, caller(OTHER));
		await pg.query("update vendors set domain = 'other.example', domain_verified_at = now() where id = $1", [OTHER]);
		await dispatchTool("add_host", { host: "app.other.example" }, caller(OTHER));
		await dispatchTool("update_vendor", { domain: "renamed.example" }, caller(OTHER));
		const { rows } = await pg.query("select host from vendor_hosts where vendor_id = $1", [OTHER]);
		expect(rows).toEqual([]);
	});

	it("the daily re-check clears an own-DNS host after three misses over two days", async () => {
		const { recheckOwnDnsHosts } = await import("./hosts");
		await pg.query("update vendor_hosts set verified_at = now() where host = 'eu.subv.example'");
		const t0 = Date.parse("2026-10-13T04:30:00Z");
		const day = 24 * 60 * 60 * 1000;
		for (let i = 0; i < 2; i++) {
			const r = await recheckOwnDnsHosts(pgliteSupabase(pg) as never, undefined, () => new Date(t0 + i * day));
			expect(r.unverified).toEqual([]);
		}
		const last = await recheckOwnDnsHosts(pgliteSupabase(pg) as never, undefined, () => new Date(t0 + 2 * day));
		expect(last.unverified).toEqual(["subv:eu.subv.example"]);
		const { rows } = await pg.query<{ verified_at: string | null }>("select verified_at from vendor_hosts where host = 'eu.subv.example'");
		expect(rows[0].verified_at).toBeNull();
	});
});
