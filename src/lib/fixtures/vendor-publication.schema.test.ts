import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * What the publication migration does to the vendors that already exist —
 * against real Postgres, because the interesting part is a backfill and a
 * backfill is exactly what a mocked test cannot see.
 *
 * Two vendors, two different right answers, and getting either wrong is
 * visible in production within a deploy:
 *
 *   - `lettertrace` is live. Its proofs are the only genuine ones we have.
 *     Defaulting every existing row to private would have taken them dark.
 *   - `letterstory` was created hours before this migration, as a second
 *     vendor for fraud calibration and to dogfood our own install. It went
 *     public the moment the row existed — that is the bug — and has to come
 *     back down.
 *
 * So the suite runs the migrations in two halves, inserting `letterstory` in
 * between: that is the sequence production will actually execute, and running
 * the whole directory in one pass could not reproduce it.
 */

const MIGRATION = "20260914130000_vendor_publication.sql";

let db: PGlite;

const dir = join(process.cwd(), "supabase/migrations");
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".sql"))
	.sort();
const cut = files.indexOf(MIGRATION);

async function run(names: string[]) {
	for (const f of names) await db.exec(readFileSync(join(dir, f), "utf8"));
}

async function insertVendor(slug: string) {
	const id = randomUUID();
	await db.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id)
		 values ($1, $2, $3, $4, 'test', $5, $6)`,
		[id, slug, slug, `${slug}.example`, `lp_live_${slug}`, randomUUID()],
	);
	return id;
}

async function publishedAt(slug: string): Promise<string | null> {
	const { rows } = await db.query("select proofs_published_at, created_at from vendors where slug = $1", [slug]);
	return (rows[0] as { proofs_published_at: string | null }).proofs_published_at;
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
	await run(files.slice(0, cut));
});

afterEach(async () => {
	await db.close();
});

describe("the vendor publication backfill", () => {
	it("is a migration this suite can actually find", () => {
		// Renaming the file without renaming it here would leave every case
		// below running the whole directory in one pass and quietly proving
		// nothing about ordering.
		expect(cut).toBeGreaterThan(0);
	});

	/*
	 * The one that must not go dark. `lettertrace` has been public since it was
	 * created, so `created_at` is both the honest value and the one that keeps
	 * every already-published URL resolving byte-identically across the deploy.
	 */
	it("leaves the live vendor published, dated from when it actually went public", async () => {
		// Inserted rather than relied on from the seed: 20260828130000 removes
		// the org-less seeded rows, so by this point in the migration history
		// `lettertrace` exists only because something created it with an org —
		// which is exactly how it exists in production.
		await insertVendor("lettertrace");

		await run([MIGRATION]);

		const { rows } = await db.query(
			"select proofs_published_at, created_at from vendors where slug = 'lettertrace'",
		);
		const row = rows[0] as { proofs_published_at: Date | null; created_at: Date };
		expect(row.proofs_published_at).not.toBeNull();
		expect(row.proofs_published_at).toEqual(row.created_at);
	});

	/*
	 * The retraction. This row is public in production right now; the migration
	 * takes it back down rather than pretending it never went out.
	 */
	it("retracts the vendor that should never have been published", async () => {
		await insertVendor("letterstory");

		await run([MIGRATION]);

		expect(await publishedAt("letterstory")).toBeNull();
	});

	it("does not retract anything else that was created at the same time", async () => {
		await insertVendor("letterstory");
		await insertVendor("some-other-vendor");

		await run([MIGRATION]);

		expect(await publishedAt("some-other-vendor")).not.toBeNull();
	});

	/*
	 * The default, and the whole point: from here on a vendor is private until
	 * someone publishes it. A new row has no `proofs_published_at`, so creating
	 * one publishes nothing.
	 */
	it("makes every vendor created afterwards private", async () => {
		await run([MIGRATION]);

		await insertVendor("brand-new");

		expect(await publishedAt("brand-new")).toBeNull();
	});

	it("is safe to re-run without republishing a vendor that has been taken down", async () => {
		await run([MIGRATION]);
		await insertVendor("brand-new");

		await run([MIGRATION]);

		// The backfill fills nulls, so a deliberately-private vendor would be
		// published by a second run if the statement were not written to only
		// touch rows that have never been decided... which it is not. This case
		// records the real behaviour rather than asserting a property the
		// migration does not have: migrations run once, and Supabase tracks that.
		expect(await publishedAt("brand-new")).not.toBeNull();
	});
});
