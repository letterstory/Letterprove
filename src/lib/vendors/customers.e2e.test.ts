import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * customers.test.ts exercises createCustomer/updateCustomer's domain gate
 * against an in-memory fake `.from().insert().select().single()` chain — it
 * proves the code makes the right calls, not that those calls match
 * vendor_customers' and vendors' real schema. This file runs the same,
 * unmodified createCustomer/updateCustomer against a real (embedded, WASM)
 * Postgres with the actual migrations applied — same technique as
 * registry.e2e.test.ts and route.schema.test.ts — so the vendor-scoped
 * self-dealing check (this PR's actual change: classifyDomain now reads the
 * calling vendor's own `domain` column) is proven against the real column it
 * reads, not a mock that could silently drift from the migration.
 *
 * What this specifically has to show, end to end against real rows:
 *   1. An external vendor (domain outside the Letter Company's own set) can
 *      create The Letter Company as a real customer — the feature this PR
 *      exists to unblock — and the row actually lands in vendor_customers.
 *   2. A Letter Company vendor (its own `domain` column is itself internal)
 *      is still refused, and nothing is written — the self-dealing case the
 *      gate exists to prevent stays prevented.
 *   3. The same two outcomes hold for updateCustomer, since gating only
 *      creation would leave the rule trivially bypassable.
 */

let pg: PGlite;

const EXTERNAL_VENDOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INTERNAL_VENDOR_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeAll(async () => {
	pg = new PGlite();

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

	// One vendor genuinely outside the Letter Company, one that IS one of
	// ours (its own domain is in the INTERNAL set the same way
	// lettertrace.com is) — real rows in the real `vendors` table.
	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key) values ($1, 'e2e-external', 'E2E External Vendor', 'e2e-vendor.example', 'test', 'lp_live_e2e_external')",
		[EXTERNAL_VENDOR_ID],
	);
	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key) values ($1, 'e2e-lettertrace', 'Lettertrace (e2e)', 'lettertrace.com', 'internal', 'lp_live_e2e_internal')",
		[INTERNAL_VENDOR_ID],
	);
});

afterAll(async () => {
	await pg.close();
});

/**
 * A `.from(table).select(cols).eq(...).maybeSingle()` /
 * `.insert(row).select(cols).single()` / `.update(patch).eq(...).eq(...)
 * .select(cols).maybeSingle()` shim backed by the real pglite Postgres —
 * enough of the client surface for createCustomer/updateCustomer, unmodified.
 */
function pgliteSupabase() {
	return {
		from(table: string) {
			const state: {
				columns: string;
				filters: [string, unknown][];
				insertRow?: Record<string, unknown>;
				updatePatch?: Record<string, unknown>;
			} = { columns: "*", filters: [] };

			async function execute() {
				if (state.insertRow) {
					const cols = Object.keys(state.insertRow);
					const placeholders = cols.map((_, i) => `$${i + 1}`);
					const { rows } = await pg.query(
						`insert into ${table} (${cols.join(", ")}) values (${placeholders.join(", ")}) returning ${state.columns}`,
						Object.values(state.insertRow),
					);
					return { data: rows[0] ?? null, error: null };
				}
				if (state.updatePatch) {
					const cols = Object.keys(state.updatePatch);
					const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
					const whereClause = state.filters.map(([c], i) => `${c} = $${cols.length + i + 1}`).join(" and ");
					const { rows } = await pg.query(
						`update ${table} set ${setClause}${whereClause ? ` where ${whereClause}` : ""} returning ${state.columns}`,
						[...Object.values(state.updatePatch), ...state.filters.map(([, v]) => v)],
					);
					return { data: rows[0] ?? null, error: null };
				}
				const where = state.filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
				const { rows } = await pg.query(
					`select ${state.columns} from ${table}${where ? ` where ${where}` : ""} limit 1`,
					state.filters.map(([, v]) => v),
				);
				return { data: rows[0] ?? null, error: null };
			}

			const builder = {
				select(columns: string) {
					state.columns = columns;
					return builder;
				},
				eq(column: string, value: unknown) {
					state.filters.push([column, value]);
					return builder;
				},
				insert(row: Record<string, unknown>) {
					state.insertRow = row;
					return builder;
				},
				update(patch: Record<string, unknown>) {
					state.updatePatch = patch;
					return builder;
				},
				maybeSingle: execute,
				single: execute,
			};
			return builder;
		},
	};
}

beforeEach(() => vi.clearAllMocks());

async function customerRow(vendorId: string, slug: string): Promise<{ domain: string } | null> {
	const { rows } = await pg.query<{ domain: string }>(
		"select * from vendor_customers where vendor_id = $1 and slug = $2",
		[vendorId, slug],
	);
	return rows[0] ?? null;
}

describe("createCustomer against a real Postgres schema", () => {
	it("lets an external vendor add The Letter Company as a real, consented customer", async () => {
		const { createCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		const result = await createCustomer(supabase as never, EXTERNAL_VENDOR_ID, {
			slug: "letterbrace-e2e",
			name: "Letterbrace",
			domain: "letterbrace.com",
			since: "2024-01",
			consent: "named",
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.domain).toBe("letterbrace.com");

		const row = await customerRow(EXTERNAL_VENDOR_ID, "letterbrace-e2e");
		expect(row).not.toBeNull();
		expect(row!.domain).toBe("letterbrace.com");
	});

	it("refuses a Letter Company vendor claiming another Letter Company domain as its customer", async () => {
		const { createCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		const result = await createCustomer(supabase as never, INTERNAL_VENDOR_ID, {
			slug: "letterbrace-e2e-2",
			name: "Letterbrace",
			domain: "letterbrace.com",
			since: "2024-01",
			consent: "named",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.body.kind).toBe("internal");

		const row = await customerRow(INTERNAL_VENDOR_ID, "letterbrace-e2e-2");
		expect(row).toBeNull();
	});
});

describe("updateCustomer against a real Postgres schema", () => {
	it("lets an external vendor move an existing customer onto a Letter Company domain", async () => {
		const { createCustomer, updateCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		await createCustomer(supabase as never, EXTERNAL_VENDOR_ID, {
			slug: "moves-to-letterbrace",
			name: "Placeholder",
			domain: "placeholder.example.com",
			since: "2024-01",
		});

		const result = await updateCustomer(supabase as never, EXTERNAL_VENDOR_ID, "moves-to-letterbrace", {
			domain: "letterbrace.com",
		});

		expect(result.ok).toBe(true);
		const row = await customerRow(EXTERNAL_VENDOR_ID, "moves-to-letterbrace");
		expect(row!.domain).toBe("letterbrace.com");
	});

	it("refuses a Letter Company vendor moving a customer onto another Letter Company domain", async () => {
		const { createCustomer, updateCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		await createCustomer(supabase as never, INTERNAL_VENDOR_ID, {
			slug: "stays-put",
			name: "Placeholder",
			domain: "placeholder2.example.com",
			since: "2024-01",
		});

		const result = await updateCustomer(supabase as never, INTERNAL_VENDOR_ID, "stays-put", {
			domain: "letterstory.com",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.body.kind).toBe("internal");

		const row = await customerRow(INTERNAL_VENDOR_ID, "stays-put");
		expect(row!.domain).toBe("placeholder2.example.com");
	});
});
