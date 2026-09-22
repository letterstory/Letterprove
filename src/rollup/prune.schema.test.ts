import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Raw-event retention against real Postgres: which rows the prune deletes,
 * which it keeps, and that it never touches the rollups built from them.
 */

let db: PGlite;

const dir = join(process.cwd(), "supabase/migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

async function insertEvent(ageDays: number) {
  await db.query(
    `insert into hot_events (vendor_slug, domain, ev, cfg, origin, receipt_ts)
		 values ('acme', 'customer.example', 'session', 1, 'https://acme.example', now() - make_interval(secs => $1::double precision * 86400))`,
    [ageDays],
  );
}

async function count(sql: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql);
  return Number(rows[0].n);
}

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

describe("prune_hot_events", () => {
  it("deletes raw events older than 35 days and keeps everything inside the 30-day read window", async () => {
    for (const age of [0, 1, 29.9, 31, 34.9, 35.1, 60, 400])
      await insertEvent(age);

    const { rows } = await db.query<{ prune_hot_events: number }>(
      "select prune_hot_events()",
    );
    expect(Number(rows[0].prune_hot_events)).toBe(3);

    expect(await count("select count(*) n from hot_events")).toBe(5);
    expect(
      await count(
        "select count(*) n from hot_events where receipt_ts < now() - interval '35 days'",
      ),
    ).toBe(0);
    expect(
      await count(
        "select count(*) n from hot_events where receipt_ts >= now() - interval '30 days'",
      ),
    ).toBe(3);
  });

  it("is a no-op on a second run", async () => {
    await insertEvent(40);
    await db.query("select prune_hot_events()");
    const { rows } = await db.query<{ prune_hot_events: number }>(
      "select prune_hot_events()",
    );
    expect(Number(rows[0].prune_hot_events)).toBe(0);
  });

  it("leaves hot_rollups alone, so all-time first-seen history survives the raw rows", async () => {
    await insertEvent(40);
    await db.query(
      `insert into hot_rollups (vendor_slug, domain, window_start, sessions, signups, logins, computed_at)
			 values ('acme', 'customer.example', date_trunc('hour', now() - interval '40 days'), 1, 0, 0, now())`,
    );
    await db.query("select prune_hot_events()");
    expect(await count("select count(*) n from hot_events")).toBe(0);
    expect(await count("select count(*) n from hot_rollups")).toBe(1);
  });

  it("indexes receipt_ts on its own, for the rollup's and the prune's time filter", async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where tablename = 'hot_events' and indexname = 'hot_events_receipt_idx'",
    );
    expect(rows[0]?.indexdef).toMatch(/\(receipt_ts\)/);
  });
});
