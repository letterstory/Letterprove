import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * The Letterstory-service vendor lifecycle, end to end against the REAL schema.
 *
 * registry.provisioning.test.ts exercises the same tools against an in-memory
 * fake `.from()` chain — it proves dispatchTool issues the right calls, not
 * that they match the real `vendors` table after the unification migration
 * (the `letterstory_org_id` column + its partial-unique index,
 * 20260825060000_vendor_letterstory_org.sql). This file runs the same,
 * unmodified `dispatchTool` — through `create_vendor` (provisionVendorForOrg)
 * and `find_vendor_by_org` (findVendorByOrg) — against a real (embedded, WASM)
 * Postgres with the actual migrations applied, driven by the same trusted-org
 * service principal the live seam uses (orgId set, no vendor_members). So a
 * schema drift (a renamed column, a dropped index, a type mismatch) fails here
 * instead of at the first live Letterstory -> Letterprove call.
 *
 * Scope note: `get_proof_summary` (vendorProof) is deliberately NOT exercised
 * here — its rollup fans out through several aggregation helpers whose query
 * surface a hand shim can't faithfully reproduce, and it is already covered by
 * its own unit tests plus a live prod round-trip (200 with tier/zeros). The
 * gap this file closes is the WRITE + linked-read against the unification
 * schema, which those never touch.
 */

const ORG = "c0ffee00-0000-4000-8000-000000000001";
const OTHER_ORG = "c0ffee00-0000-4000-8000-000000000002";

let pg: PGlite;

beforeAll(async () => {
	pg = await bootstrapPglite();
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase(pg) as never);
});

function service(orgId: string): OAuthPrincipal {
	return {
		tokenId: "letterstory-service",
		vendorId: null,
		userId: "letterstory-service",
		capabilities: ["vendor:read", "vendor:write"],
		orgId,
	};
}

describe("vendor lifecycle over the real dispatchTool + real unification schema", () => {
	it("links a vendor for an org, then reads it back — create -> linked find", async () => {
		const { dispatchTool } = await import("./registry");

		// 1. Unlinked to start.
		const before = await dispatchTool("find_vendor_by_org", { org_id: ORG }, service(ORG));
		expect(before).toMatchObject({ kind: "result", result: { ok: true, body: { linked: false } } });

		// 2. create_vendor provisions a real row against the real schema.
		const created = await dispatchTool(
			"create_vendor",
			{ name: "E2E Lifecycle Test", domain: "e2e-lifecycle.example.com" },
			service(ORG),
		);
		expect(created).toMatchObject({
			kind: "result",
			result: { ok: true, status: 201, body: { linked: true, slug: "e2e-lifecycle-test" } },
		});

		// The row physically exists, carrying letterstory_org_id — the column the
		// unification migration added and the whole trusted-org model hangs on.
		const { rows } = await pg.query<{ letterstory_org_id: string; slug: string }>(
			"select letterstory_org_id, slug from vendors where letterstory_org_id = $1",
			[ORG],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].slug).toBe("e2e-lifecycle-test");

		// 3. The linked read path — never observed before this system existed.
		const after = await dispatchTool("find_vendor_by_org", { org_id: ORG }, service(ORG));
		expect(after).toMatchObject({
			kind: "result",
			result: { ok: true, body: { linked: true, slug: "e2e-lifecycle-test", domain: "e2e-lifecycle.example.com" } },
		});
	});

	it("refuses a second vendor for an already-linked org (409)", async () => {
		const { dispatchTool } = await import("./registry");

		await dispatchTool("create_vendor", { name: "First", domain: "first.example.com" }, service(OTHER_ORG));

		const dupe = await dispatchTool("create_vendor", { name: "Second", domain: "second.example.com" }, service(OTHER_ORG));
		expect(dupe).toMatchObject({ kind: "result", result: { ok: false, status: 409 } });

		// Exactly one vendor for the org — the second never landed.
		const { rows } = await pg.query("select id from vendors where letterstory_org_id = $1", [OTHER_ORG]);
		expect(rows).toHaveLength(1);
	});

	it("the DB itself rejects a duplicate letterstory_org_id (partial-unique index is the backstop)", async () => {
		// Prove the real schema guard, not just the app pre-check: a direct second
		// insert for ORG (linked in the first test) must violate the partial-unique
		// index vendors_letterstory_org_id_idx.
		await expect(
			pg.query(
				"insert into vendors (id, slug, name, domain, category, key, letterstory_org_id) values (gen_random_uuid(), 'dupe-direct', 'Dupe', 'dupe.example.com', 'software', 'lp_live_e2e_dupe', $1)",
				[ORG],
			),
		).rejects.toThrow();
	});
});
