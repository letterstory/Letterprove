import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

/**
 * A new proof waits for data before it joins the directory, end to end
 * against the real schema: publish_proofs leaves it unlisted and marked as
 * waiting, the freeze's listing step lists it with the first snapshot that has
 * a company in it, and a vendor's own choice (or an existing vendor) is never
 * touched.
 */

let pg: PGlite;
vi.mock("@/lib/db/client", () => ({ dbClient: () => pgliteSupabase(pg) }));

const FRESH = randomUUID();
const PRIVATE_DATA = randomUUID();
const CHOSE = randomUUID();
const OLD = randomUUID();

function caller(vendorId: string): OAuthPrincipal {
	return { tokenId: "letterstory-service", vendorId, userId: "letterstory-service", capabilities: ["vendor:read", "vendor:write"], orgId: "e2e" };
}

async function vendor(id: string, slug: string, extra = "") {
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verified_at)
		 values ($1, $2, $2, $3, 'test', $4, gen_random_uuid(), now())`,
		[id, slug, `${slug}.example`, `lp_live_${slug}`],
	);
	if (extra) await pg.query(`update vendors set ${extra} where id = $1`, [id]);
}

async function snapshot(slug: string, hour: number, companies: number) {
	await pg.query(
		`insert into published_aggregates (vendor_slug, hour_bucket, published_at, attestation) values ($1, $2, now(), $3)`,
		[slug, hour, JSON.stringify({ companies_observed: companies })],
	);
}

async function row(id: string) {
	const { rows } = await pg.query<{ proofs_listed: boolean; listed_changed_by: string | null }>(
		`select proofs_listed, listed_changed_by from vendors where id = $1`,
		[id],
	);
	return rows[0];
}

beforeAll(async () => {
	pg = await bootstrapPglite();
	await vendor(FRESH, "fresh");
	await vendor(PRIVATE_DATA, "privdata");
	await snapshot("privdata", 1, 4);
	await vendor(CHOSE, "chose");
	// An existing published vendor someone unlisted by hand (like Letter's own).
	await vendor(OLD, "old", "proofs_published_at = now(), proofs_listed = false, listed_changed_by = 'some-user'");
});

afterAll(async () => {
	await pg.close();
});

describe("a new proof joins the directory with its first sign-ins", () => {
	it("publish with no data leaves it unlisted and pending", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const out = await dispatchTool("publish_proofs", {}, caller(FRESH));
		expect(out).toMatchObject({ result: { ok: true, body: { published: true, listed: false, listing_pending_data: true } } });
		expect(await row(FRESH)).toEqual({ proofs_listed: false, listed_changed_by: "system:awaiting_data" });
		const status = await dispatchTool("get_status", {}, caller(FRESH));
		expect(status).toMatchObject({ result: { ok: true, body: { listed: false, listing_pending_data: true } } });
	});

	it("a snapshot with zero companies does not list it; the first with sign-ins does", async () => {
		const { autoListOnFirstData } = await import("./listing");
		const db = pgliteSupabase(pg);
		expect(await autoListOnFirstData(db as never, "fresh", 0)).toBe(false);
		expect((await row(FRESH)).proofs_listed).toBe(false);
		expect(await autoListOnFirstData(db as never, "fresh", 3)).toBe(true);
		expect(await row(FRESH)).toEqual({ proofs_listed: true, listed_changed_by: "system:first_data" });
	});

	it("a vendor who collected privately and already has data lists at once", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const out = await dispatchTool("publish_proofs", {}, caller(PRIVATE_DATA));
		expect(out).toMatchObject({ result: { ok: true, body: { listed: true, listing_pending_data: false } } });
		expect((await row(PRIVATE_DATA)).proofs_listed).toBe(true);
	});

	it("a vendor's own unlisting is never overridden by first data", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		await dispatchTool("publish_proofs", {}, caller(CHOSE));
		await dispatchTool("set_proof_listing", { listed: false }, caller(CHOSE));
		const { autoListOnFirstData } = await import("./listing");
		expect(await autoListOnFirstData(pgliteSupabase(pg) as never, "chose", 9)).toBe(false);
		expect((await row(CHOSE)).proofs_listed).toBe(false);
	});

	it("an existing published vendor keeps its state", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const out = await dispatchTool("publish_proofs", {}, caller(OLD));
		expect(out).toMatchObject({ result: { ok: true, body: { listed: false, listing_pending_data: false } } });
		const { autoListOnFirstData } = await import("./listing");
		expect(await autoListOnFirstData(pgliteSupabase(pg) as never, "old", 9)).toBe(false);
		expect(await row(OLD)).toEqual({ proofs_listed: false, listed_changed_by: "some-user" });
	});
});
