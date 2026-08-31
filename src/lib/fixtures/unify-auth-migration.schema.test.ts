import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The destructive half of the auth unification (supabase/proposed/
 * 20260828130000_unify_auth_drop_local_identity.sql), replayed against real
 * Postgres.
 *
 * This exists because of a near-miss. Step 4 was written as a bare
 * `delete from vendors where letterstory_org_id is null`, on the stated belief
 * that org-less vendors were "the seed fixtures (vantage, lettertrace) … none
 * are production data". Nothing had ever backfilled letterstory_org_id, so in
 * production on 2026-08-31 that predicate matched EVERY vendor — including
 * `lettertrace` and the nine vendor_customers rows that cascade off it.
 *
 * A belief about production data is not something a mocked test can check, and
 * the migration file cannot check it either. What CAN be checked is that the
 * migration refuses to run when the belief is false — which is what the guard
 * added to step 4 does, and what these cases pin down.
 *
 * The seeded fixtures make the point without any setup: 20260814230000 ships
 * `vantage` and `lettertrace` org-less, and gives vantage customers. So a
 * freshly-migrated database is ALREADY in the state the bare delete would have
 * destroyed data in.
 *
 * Each case gets its own database — the migration is irreversible by design.
 */

let db: PGlite;

const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const PROPOSED = join(
	process.cwd(),
	"supabase/proposed/20260828130000_unify_auth_drop_local_identity.sql",
);

async function applyProposed(): Promise<void> {
	await db.exec(readFileSync(PROPOSED, "utf8"));
}

async function link(slug: string): Promise<void> {
	await db.query("update vendors set letterstory_org_id = $1 where slug = $2", [randomUUID(), slug]);
}

async function vendorSlugs(): Promise<string[]> {
	const { rows } = await db.query<{ slug: string }>("select slug from vendors order by slug");
	return rows.map((r) => r.slug);
}

async function customerCount(vendorSlug: string): Promise<number> {
	const { rows } = await db.query<{ n: number }>(
		"select count(c.*)::int as n from vendor_customers c join vendors v on v.id = c.vendor_id where v.slug = $1",
		[vendorSlug],
	);
	return rows[0].n;
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
	for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
		await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
	}
});

afterEach(async () => {
	await db.close();
});

describe("unify-auth step 2: dropping org-less vendors", () => {
	it("aborts rather than cascade-deleting an org-less vendor that still has customers", async () => {
		const before = await customerCount("vantage");
		expect(before).toBeGreaterThan(0);

		await expect(applyProposed()).rejects.toThrow(/vantage/);

		// The abort has to leave the vendor AND its customers intact — a guard
		// that raised after the delete would be no guard at all.
		expect(await vendorSlugs()).toContain("vantage");
		expect(await customerCount("vantage")).toBe(before);
	});

	it("names every stranded vendor, not just the first one it meets", async () => {
		await db.query(
			`insert into vendor_customers (vendor_id, slug, name, domain, since)
			 select id, 'overmindlab', 'Overmindlab', 'overmindlab.ai', '2025-11' from vendors where slug = 'lettertrace'`,
		);

		await expect(applyProposed()).rejects.toThrow(/lettertrace, vantage/);
	});

	it("proceeds once they are linked, keeping the vendors and their customers", async () => {
		const before = await customerCount("vantage");
		await link("vantage");
		await link("lettertrace");

		await applyProposed();

		expect(await vendorSlugs()).toEqual(["lettertrace", "vantage"]);
		expect(await customerCount("vantage")).toBe(before);
	});

	it("still drops an org-less vendor that carries nothing, and requires the link after", async () => {
		await db.query("delete from vendor_customers");
		await link("lettertrace");

		await applyProposed();

		// vantage was org-less and empty — exactly the case the step exists for.
		expect(await vendorSlugs()).toEqual(["lettertrace"]);
		await expect(
			db.query(
				`insert into vendors (slug, name, domain, category, key)
				 values ('newcomer', 'Newcomer', 'newcomer.com', 'test', 'lp_live_newcomer')`,
			),
		).rejects.toThrow();
	});
});
