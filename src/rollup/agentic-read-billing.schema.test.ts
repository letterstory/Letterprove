import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Agentic-read billing against real Postgres: the rollup buckets by
 * calendar month and is idempotent, the prune keeps the rollup's window,
 * and the pricing this backs (src/lib/billing/agentic-reads.ts) gets a real
 * count to work from.
 */

let db: PGlite;

const dir = join(process.cwd(), "supabase/migrations");
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".sql"))
	.sort();

async function insertRead(vendorSlug: string, ageDays: number) {
	await db.query(
		`insert into agentic_read_events (vendor_slug, subject, agent_name, receipt_ts)
		 values ($1, $1, 'chatgpt', now() - make_interval(secs => $2::double precision * 86400))`,
		[vendorSlug, ageDays]
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

describe("rollup_agentic_reads_daily", () => {
	it("counts this month's reads per vendor into agentic_read_rollups", async () => {
		await insertRead("acme", 0);
		await insertRead("acme", 1);
		await insertRead("acme", 2);
		await insertRead("vantage", 0);

		await db.query("select rollup_agentic_reads_daily()");

		const { rows } = await db.query<{ vendor_slug: string; read_count: number }>(
			"select vendor_slug, read_count from agentic_read_rollups order by vendor_slug"
		);
		expect(rows).toEqual([
			{ vendor_slug: "acme", read_count: 3 },
			{ vendor_slug: "vantage", read_count: 1 },
		]);
	});

	it("is idempotent: rerunning it recomputes rather than double-counting", async () => {
		await insertRead("acme", 0);
		await db.query("select rollup_agentic_reads_daily()");
		await insertRead("acme", 0);
		await db.query("select rollup_agentic_reads_daily()");

		expect(await count("select read_count n from agentic_read_rollups where vendor_slug = 'acme'")).toBe(2);
		expect(await count("select count(*) n from agentic_read_rollups where vendor_slug = 'acme'")).toBe(1);
	});

	it("still buckets a read from last month into last month's row, not this month's", async () => {
		// 40 days ago is always in the prior calendar month relative to now,
		// which is what "current AND previous month" in the migration's
		// comment means to cover.
		await insertRead("acme", 40);
		await insertRead("acme", 0);

		await db.query("select rollup_agentic_reads_daily()");

		const { rows } = await db.query<{ billing_month: string; read_count: number }>(
			"select billing_month, read_count from agentic_read_rollups where vendor_slug = 'acme' order by billing_month"
		);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.read_count === 1)).toBe(true);
		expect(rows[0].billing_month).not.toBe(rows[1].billing_month);
	});
});

describe("prune_agentic_read_events", () => {
	it("deletes raw events older than 65 days and keeps everything inside the billing window", async () => {
		for (const age of [0, 1, 60, 64.9, 65.1, 90, 400]) await insertRead("acme", age);

		const { rows } = await db.query<{ prune_agentic_read_events: number }>("select prune_agentic_read_events()");
		expect(Number(rows[0].prune_agentic_read_events)).toBe(3);

		expect(await count("select count(*) n from agentic_read_events")).toBe(4);
		expect(await count("select count(*) n from agentic_read_events where receipt_ts < now() - interval '65 days'")).toBe(
			0
		);
	});

	it("is a no-op on a second run", async () => {
		await insertRead("acme", 90);
		await db.query("select prune_agentic_read_events()");
		const { rows } = await db.query<{ prune_agentic_read_events: number }>("select prune_agentic_read_events()");
		expect(Number(rows[0].prune_agentic_read_events)).toBe(0);
	});

	it("leaves agentic_read_rollups alone, so a closed month's billed total survives the raw rows", async () => {
		await insertRead("acme", 90);
		await db.query(
			`insert into agentic_read_rollups (vendor_slug, billing_month, read_count, computed_at)
			 values ('acme', date_trunc('month', now() - interval '90 days')::date, 1, now())`
		);
		await db.query("select prune_agentic_read_events()");
		expect(await count("select count(*) n from agentic_read_events")).toBe(0);
		expect(await count("select count(*) n from agentic_read_rollups")).toBe(1);
	});
});
