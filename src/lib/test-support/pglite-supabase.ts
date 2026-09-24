/**
 * Shared harness for this repo's pglite-Postgres e2e tests: an embedded
 * (WASM) Postgres with the real `supabase/migrations/*.sql` files replayed
 * into it, plus a hand-rolled Supabase-client query-builder shim over it.
 *
 * Extracted from five files that each carried a near-identical copy of this
 * setup (registry.e2e.test.ts, customers.e2e.test.ts,
 * vendor-lifecycle.e2e.test.ts, consent.schema.test.ts,
 * observe/route.e2e.test.ts) — see ops todo.md's "extract the duplicated
 * pglite-Postgres e2e harness" item. Deliberately does NOT test RLS: every
 * caller here is service-role code, and this shim never applies policies.
 *
 * See ops memory reference_pglite-migration-regression-test.md for the
 * technique's origin and rationale (Letterprove #87).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";

/**
 * Boots an embedded Postgres, bootstraps the Supabase-specific bits the raw
 * migration files assume exist (roles, `auth.users`, `auth.uid()`), then
 * replays every migration in `supabase/migrations` in sorted order.
 */
export async function bootstrapPglite(): Promise<PGlite> {
	const pg = new PGlite();

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

	return pg;
}

type Op = "=" | ">" | ">=" | "<" | "<=";
type Where = { col: string; op: Op; val: unknown };
type PgError = { code?: string; message: string };

function pgError(e: unknown): PgError {
	const err = e as { code?: string; message?: string };
	const message = String(err.message ?? e);
	const code = err.code ?? (message.includes("duplicate key") ? "23505" : undefined);
	return { code, message };
}

/**
 * A `.from(table)` query-builder shim backed by a real pglite Postgres
 * instance, covering enough of the Supabase client surface for every
 * service function this repo's e2e suite drives unmodified:
 *
 *   select / eq / gt / gte / order / range -> maybeSingle | single | (awaited list)
 *   insert(row | row[]) -> maybeSingle | single | (awaited)
 *   update(patch).eq()... .select(returning) -> maybeSingle | single
 *   upsert(row, { onConflict }) -> (awaited)
 *   delete().eq()... -> (awaited)
 *
 * Every clause it builds is a real SQL statement against `pg` — nothing here
 * is faked except the two non-Postgres boundaries `withAuthAdmin` stubs
 * (Supabase Auth Admin's REST API, not a SQL table).
 */
export function pgliteSupabase(pg: PGlite, opts: { withAuthAdmin?: boolean } = {}) {
	const client = {
		from(table: string) {
			const wheres: Where[] = [];
			const orderBys: { col: string; ascending: boolean }[] = [];
			let mode: "select" | "insert" | "update" | "delete" | "upsert" | null = null;
			let selectCols = "*";
			let returningCols = "id";
			let insertRows: Record<string, unknown>[] | undefined;
			let updatePatch: Record<string, unknown> | undefined;
			let upsertRow: Record<string, unknown> | undefined;
			let upsertConflict = "id";
			let rangeFrom: number | undefined;
			let rangeTo: number | undefined;

			function whereClause(offset = 0) {
				return wheres.map((w, i) => `${w.col} ${w.op} $${offset + i + 1}`).join(" and ");
			}

			async function runSelect(limitOne: boolean) {
				const clause = whereClause();
				const order = orderBys.length
					? ` order by ${orderBys.map((o) => `${o.col} ${o.ascending ? "asc" : "desc"}`).join(", ")}`
					: "";
				const limit = limitOne
					? " limit 1"
					: rangeFrom !== undefined
						? ` limit ${rangeTo! - rangeFrom + 1} offset ${rangeFrom}`
						: "";
				try {
					const { rows } = await pg.query(
						`select ${selectCols} from ${table}${clause ? ` where ${clause}` : ""}${order}${limit}`,
						wheres.map((w) => w.val),
					);
					return { data: limitOne ? (rows[0] ?? null) : rows, error: null };
				} catch (e) {
					return { data: null, error: e instanceof Error ? e : new Error(String(e)) };
				}
			}

			async function runInsert(limitOne: boolean) {
				const rows = insertRows!;
				const cols = Object.keys(rows[0]);
				const values = rows
					.map((_, ri) => `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(", ")})`)
					.join(", ");
				const params = rows.flatMap((r) => cols.map((c) => r[c]));
				try {
					const { rows: returned } = await pg.query(
						`insert into ${table} (${cols.join(", ")}) values ${values} returning ${selectCols}`,
						params,
					);
					return { data: limitOne ? (returned[0] ?? null) : returned, error: null };
				} catch (e) {
					return { data: null, error: pgError(e) };
				}
			}

			async function runUpdate() {
				const cols = Object.keys(updatePatch!);
				const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
				const clause = whereClause(cols.length);
				try {
					const { rows } = await pg.query(
						`update ${table} set ${setClause}${clause ? ` where ${clause}` : ""} returning ${returningCols}`,
						[...cols.map((c) => updatePatch![c]), ...wheres.map((w) => w.val)],
					);
					return { data: rows[0] ?? null, error: null };
				} catch (e) {
					return { data: null, error: pgError(e) };
				}
			}

			async function runDelete() {
				const clause = whereClause();
				try {
					await pg.query(`delete from ${table}${clause ? ` where ${clause}` : ""}`, wheres.map((w) => w.val));
					return { data: null, error: null };
				} catch (e) {
					return { data: null, error: pgError(e) };
				}
			}

			async function runUpsert() {
				const cols = Object.keys(upsertRow!);
				const placeholders = cols.map((_, i) => `$${i + 1}`);
				const updateSet = cols
					.filter((c) => c !== upsertConflict)
					.map((c) => `${c} = excluded.${c}`)
					.join(", ");
				try {
					await pg.query(
						`insert into ${table} (${cols.join(", ")}) values (${placeholders.join(", ")})
						 on conflict (${upsertConflict}) do update set ${updateSet}`,
						Object.values(upsertRow!),
					);
					return { data: null, error: null };
				} catch (e) {
					return { data: null, error: pgError(e) };
				}
			}

			function terminal(limitOne: boolean) {
				if (mode === "insert") return runInsert(limitOne);
				if (mode === "update") return runUpdate();
				if (mode === "delete") return runDelete();
				if (mode === "upsert") return runUpsert();
				return runSelect(limitOne);
			}

			const builder = {
				select(cols: string) {
					if (mode === "update") returningCols = cols;
					else {
						mode = mode ?? "select";
						selectCols = cols;
					}
					return builder;
				},
				insert(row: Record<string, unknown> | Record<string, unknown>[]) {
					mode = "insert";
					insertRows = Array.isArray(row) ? row : [row];
					return builder;
				},
				update(patch: Record<string, unknown>) {
					mode = "update";
					updatePatch = patch;
					return builder;
				},
				delete() {
					mode = "delete";
					return builder;
				},
				upsert(row: Record<string, unknown>, upsertOpts?: { onConflict?: string }) {
					mode = "upsert";
					upsertRow = row;
					upsertConflict = upsertOpts?.onConflict ?? "id";
					return builder;
				},
				eq(col: string, val: unknown) {
					wheres.push({ col, op: "=", val });
					return builder;
				},
				gt(col: string, val: unknown) {
					wheres.push({ col, op: ">", val });
					return builder;
				},
				gte(col: string, val: unknown) {
					wheres.push({ col, op: ">=", val });
					return builder;
				},
				order(col: string, orderOpts?: { ascending?: boolean }) {
					orderBys.push({ col, ascending: orderOpts?.ascending !== false });
					return builder;
				},
				range(from: number, to: number) {
					rangeFrom = from;
					rangeTo = to;
					return builder;
				},
				maybeSingle: () => terminal(true),
				single: () => terminal(true),
				then<T>(onFulfilled: (v: { data: unknown; error: unknown }) => T, onRejected?: (e: unknown) => T) {
					return terminal(false).then(onFulfilled, onRejected);
				},
			};
			return builder;
		},
	};

	if (!opts.withAuthAdmin) return client;

	return {
		...client,
		auth: {
			admin: {
				getUserById: vi.fn(async (id: string) => ({ data: { user: { id, email: `${id}@example.com` } }, error: null })),
			},
		},
	};
}
