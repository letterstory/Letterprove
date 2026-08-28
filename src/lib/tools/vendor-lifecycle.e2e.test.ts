import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

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
	pg = new PGlite();

	// Supabase-specific bits the raw migration files assume exist — identical
	// setup to registry.e2e.test.ts / route.schema.test.ts.
	await pg.exec(`
		do $$ begin
			if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
			if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
			if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
		end $$;
		create schema if not exists auth;
		create table if not exists auth.users (id uuid primary key);
		create or replace function auth.uid() returns uuid language sql stable as $$
			select null::uuid
		$$;
	`);

	const dir = join(process.cwd(), "supabase/migrations");
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (const f of files) {
		await pg.exec(readFileSync(join(dir, f), "utf8"));
	}
});

afterAll(async () => {
	await pg.close();
});

/**
 * A Supabase-client shim over the real pglite Postgres — enough surface for
 * provisionVendorForOrg + findVendorByOrg, unmodified:
 *   • `.from(t).insert(row)`                    (awaited -> {error}, 23505 on unique violation)
 *   • `.from(t).select(c).eq(k,v).maybeSingle()`(single row)
 *   • `.from(t).select(c).eq(k,v)`              (awaited -> {data: rows[]})
 */
function pgliteSupabase() {
	return {
		from(table: string) {
			const state: { columns: string; filters: [string, unknown][]; insertRow?: Record<string, unknown> } = {
				columns: "*",
				filters: [],
			};

			async function runInsert() {
				const cols = Object.keys(state.insertRow!);
				const placeholders = cols.map((_, i) => `$${i + 1}`);
				try {
					await pg.query(
						`insert into ${table} (${cols.join(", ")}) values (${placeholders.join(", ")})`,
						Object.values(state.insertRow!),
					);
					return { data: null, error: null };
				} catch (e: unknown) {
					const err = e as { code?: string; message?: string };
					const code =
						err.code ?? (String(err.message ?? e).includes("duplicate key") ? "23505" : undefined);
					return { data: null, error: { code, message: String(err.message ?? e) } };
				}
			}

			async function runSelectList() {
				const where = state.filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
				const { rows } = await pg.query(
					`select ${state.columns} from ${table}${where ? ` where ${where}` : ""}`,
					state.filters.map(([, v]) => v),
				);
				return { data: rows, error: null };
			}

			const builder = {
				select(columns: string) {
					state.columns = columns;
					return builder;
				},
				insert(row: Record<string, unknown>) {
					state.insertRow = row;
					return builder;
				},
				eq(column: string, value: unknown) {
					state.filters.push([column, value]);
					return builder;
				},
				async maybeSingle() {
					const where = state.filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
					const { rows } = await pg.query(
						`select ${state.columns} from ${table}${where ? ` where ${where}` : ""} limit 1`,
						state.filters.map(([, v]) => v),
					);
					return { data: rows[0] ?? null, error: null };
				},
				// Terminal `await builder` with no `.maybeSingle()`: an insert
				// (provision) or a list select (findVendorByOrg's vendor_customers).
				then<T>(onF: (v: { data: unknown; error: unknown }) => T, onR?: (e: unknown) => T) {
					const p = state.insertRow ? runInsert() : runSelectList();
					return p.then(onF, onR);
				},
			};
			return builder;
		},
	};
}

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase() as never);
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
