import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Frozen attestation rows against real Postgres: once written they have been
 * served, so they can be added to and deleted, never rewritten. The freezes
 * already skip a frozen hour and write ON CONFLICT DO NOTHING; this is the
 * database refusing the overwrite even if a future caller forgets.
 */

let db: PGlite;

const dir = join(process.cwd(), "supabase/migrations");
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".sql"))
	.sort();

beforeEach(async () => {
	db = new PGlite();
	await db.exec(`
		do $$ begin
			if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
			if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
			if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
		end $$;
		create schema if not exists auth;
		create table if not exists auth.users (id uuid primary key);
		create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
	`);
	for (const f of files) await db.exec(readFileSync(join(dir, f), "utf8"));
});

async function attestationOf(sql: string): Promise<unknown> {
	const { rows } = await db.query<{ attestation: unknown }>(sql);
	return rows[0]?.attestation;
}

describe("published rows are insert-only", () => {
	it("refuses to rewrite a frozen customer snapshot", async () => {
		await db.query(
			`insert into published_snapshots (vendor_slug, customer_slug, hour_bucket, published_at, attestation)
			 values ('acme', 'globex', 497000, now(), '{"sessions_30d": 4}')`,
		);

		await expect(
			db.query(`update published_snapshots set attestation = '{"sessions_30d": 9999}' where vendor_slug = 'acme'`),
		).rejects.toThrow(/immutable/);
		expect(await attestationOf("select attestation from published_snapshots")).toEqual({ sessions_30d: 4 });
	});

	it("refuses to rewrite a frozen aggregate", async () => {
		await db.query(
			`insert into published_aggregates (vendor_slug, hour_bucket, published_at, attestation)
			 values ('acme', 497000, now(), '{"companies_observed": 12}')`,
		);

		await expect(
			db.query(`update published_aggregates set attestation = '{"companies_observed": 900}'`),
		).rejects.toThrow(/immutable/);
		expect(await attestationOf("select attestation from published_aggregates")).toEqual({ companies_observed: 12 });
	});

	it("keeps the first row when a second write for the same hour arrives (ON CONFLICT DO NOTHING)", async () => {
		const insert = (n: number) =>
			db.query(
				`insert into published_snapshots (vendor_slug, customer_slug, hour_bucket, published_at, attestation)
				 values ('acme', 'globex', 497000, now(), $1::jsonb)
				 on conflict (vendor_slug, customer_slug, hour_bucket) do nothing`,
				[JSON.stringify({ sessions_30d: n })],
			);
		await insert(4);
		await insert(9999);

		expect(await attestationOf("select attestation from published_snapshots")).toEqual({ sessions_30d: 4 });
	});

	it("still allows deleting rows, for retention and data-removal requests", async () => {
		await db.query(
			`insert into published_snapshots (vendor_slug, customer_slug, hour_bucket, published_at, attestation)
			 values ('acme', 'globex', 497000, now(), '{}')`,
		);
		await db.query(`delete from published_snapshots where vendor_slug = 'acme'`);

		const { rows } = await db.query<{ n: number }>("select count(*) n from published_snapshots");
		expect(Number(rows[0].n)).toBe(0);
	});
});
