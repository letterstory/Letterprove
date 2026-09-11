import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

import { shouldSendAlert, REPEAT_AFTER_MS } from "./state";

/**
 * Alert suppression against the real schema.
 *
 * state.test.ts mocks the database, so it cannot see what Postgres does to
 * these rows: whether the migration actually creates the table, whether the
 * upsert's `onConflict: "subject"` has a unique constraint to land on, or
 * whether `occurrences` comes back as a number rather than a string. Getting
 * any of those wrong fails in exactly one direction, and it is the loud one:
 * every write errors, every read falls back to "send", and the suppression
 * silently does nothing while looking installed.
 *
 * Same approach as publish.schema.test.ts, and the same reason it exists.
 */
let pg: PGlite;

/** Supabase-shaped shim over real Postgres, covering only what state.ts calls. */
function pgliteSupabase() {
	return {
		from(table: string) {
			const filters: [string, unknown][] = [];
			let columns = "*";

			const builder = {
				select(c: string) {
					columns = c;
					return builder;
				},
				eq(column: string, value: unknown) {
					filters.push([column, value]);
					return builder;
				},
				async maybeSingle() {
					const where = filters.length
						? " where " + filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ")
						: "";
					try {
						const { rows } = await pg.query(
							`select ${columns} from ${table}${where}`,
							filters.map(([, v]) => v),
						);
						return { data: rows[0] ?? null, error: null };
					} catch (e) {
						return { data: null, error: { message: (e as Error).message } };
					}
				},
				async upsert(values: Record<string, unknown>, options: { onConflict: string }) {
					const cols = Object.keys(values);
					const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
					const set = cols.map((c) => `${c} = excluded.${c}`).join(", ");
					try {
						await pg.query(
							`insert into ${table} (${cols.join(", ")}) values (${placeholders})
							 on conflict (${options.onConflict}) do update set ${set}`,
							cols.map((c) => values[c]),
						);
						return { error: null };
					} catch (e) {
						return { error: { message: (e as Error).message } };
					}
				},
			};
			return builder;
		},
	};
}

const SUBJECT = "hourly freeze failed: vendor aggregates";
const NOW = Date.parse("2026-09-10T12:00:00Z");

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
		create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
	`);
	const dir = join(process.cwd(), "supabase/migrations");
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
		await pg.exec(readFileSync(join(dir, f), "utf8"));
	}
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase() as never);
	await pg.query("delete from alert_state");
});

describe("alert suppression, against a real Postgres schema", () => {
	it("pages the first occurrence and writes one row that survives the real columns", async () => {
		expect(await shouldSendAlert(SUBJECT, NOW)).toEqual({ send: true });

		const { rows } = await pg.query("select * from alert_state where subject = $1", [SUBJECT]);
		expect(rows).toHaveLength(1);
		expect((rows[0] as { occurrences: number }).occurrences).toBe(1);
	});

	// The upsert names `onConflict: "subject"`. If the primary key were not on
	// that column the second call would throw a duplicate key error, state.ts
	// would log and carry on, and every occurrence would page forever.
	it("upserts the same subject in place rather than inserting a second row", async () => {
		await shouldSendAlert(SUBJECT, NOW);
		await shouldSendAlert(SUBJECT, NOW + 15 * 60 * 1000);

		const { rows } = await pg.query("select occurrences from alert_state where subject = $1", [SUBJECT]);
		expect(rows).toHaveLength(1);
		expect((rows[0] as { occurrences: number }).occurrences).toBe(2);
	});

	// An hourly cron reporting a condition that never recovers: the first run
	// pages, the next five are suppressed, and the sixth pages again carrying
	// what the quiet window contained.
	it("suppresses repeats and pages again once the window has passed", async () => {
		const HOUR = 60 * 60 * 1000;
		expect((await shouldSendAlert(SUBJECT, NOW)).send).toBe(true);

		for (let hour = 1; hour < REPEAT_AFTER_MS / HOUR; hour++) {
			expect((await shouldSendAlert(SUBJECT, NOW + hour * HOUR)).send).toBe(false);
		}

		const later = await shouldSendAlert(SUBJECT, NOW + REPEAT_AFTER_MS);
		expect(later.send).toBe(true);
		expect(later.context).toContain("7 occurrences");
		expect(later.context).toContain("ongoing for 6h");
	});

	// Two conditions have to be independently suppressible, or the noisiest one
	// mutes the rest.
	it("keeps one row per subject", async () => {
		await shouldSendAlert(SUBJECT, NOW);
		await shouldSendAlert("collector health check failed", NOW);

		const { rows } = await pg.query("select count(*)::int as n from alert_state");
		expect((rows[0] as { n: number }).n).toBe(2);
	});
});
