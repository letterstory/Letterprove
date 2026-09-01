import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The vendor ↔ Letterstory-org link, against the real schema.
 *
 * "A Letterprove vendor IS a Letterstory org, 1:1" is a sentence in a Slack
 * thread until something enforces it. The enforcement is a partial unique
 * index, and an index is exactly the kind of thing a mocked test cannot see —
 * `findVendorByOrg` would happily return one arbitrary row if two claimed the
 * same org, and nothing in TypeScript would object.
 *
 * So this runs the real migrations against real Postgres and asserts the three
 * properties the design actually depends on: the relationship is 1:1, it is
 * now REQUIRED (20260828130000 made the column NOT NULL — Letterprove's own
 * standalone signup is retired, so a vendor with no org is no longer a valid
 * state, only a migration bug), and the reference is deliberately NOT a
 * foreign key — organizations live in a different database, so a uuid
 * pointing at nothing has to be storable.
 */

let db: PGlite;

async function insertVendor(orgId: string | null) {
	const id = randomUUID();
	await db.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id)
		 values ($1, $2, $3, $4, 'test', $5, $6)`,
		[id, `v-${id.slice(0, 8)}`, "Test Vendor", `${id.slice(0, 8)}.com`, `lp_live_${id.slice(0, 8)}`, orgId],
	);
	return id;
}

beforeAll(async () => {
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
	const dir = join(process.cwd(), "supabase/migrations");
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
		await db.exec(readFileSync(join(dir, f), "utf8"));
	}
});

afterAll(async () => {
	await db.close();
});

describe("vendors.letterstory_org_id", () => {
	it("links a vendor to exactly one org", async () => {
		const org = randomUUID();
		const id = await insertVendor(org);

		const { rows } = await db.query("select letterstory_org_id from vendors where id = $1", [id]);
		expect((rows[0] as { letterstory_org_id: string }).letterstory_org_id).toBe(org);
	});

	/*
	 * The property the whole design rests on. Two vendors claiming one org makes
	 * "which proofs does this workspace publish?" ambiguous, and findVendorByOrg
	 * would silently answer with whichever row Postgres handed back first.
	 */
	it("refuses a second vendor claiming the same org", async () => {
		const org = randomUUID();
		await insertVendor(org);

		await expect(insertVendor(org)).rejects.toThrow(/duplicate key|unique/i);
	});

	/*
	 * Null used to be the ordinary case, back when Letterprove had its own
	 * standalone signup. 20260828130000 retired that path and made the column
	 * NOT NULL along with it — a vendor with no org is no longer state the
	 * schema can hold, only a bug in whatever inserted it.
	 */
	it("refuses a vendor with no org", async () => {
		await expect(insertVendor(null)).rejects.toThrow(/null value|not-null/i);
	});

	/*
	 * Deliberately NOT a foreign key — `organizations` is in another Postgres
	 * instance. If someone later "fixes" this by adding a real FK, the insert
	 * below starts failing and this test explains why it shouldn't.
	 */
	it("stores an org id that references nothing in this database", async () => {
		const orphan = randomUUID();
		const id = await insertVendor(orphan);

		const { rows } = await db.query("select letterstory_org_id from vendors where id = $1", [id]);
		expect((rows[0] as { letterstory_org_id: string }).letterstory_org_id).toBe(orphan);
	});

	it("guards the column against being dropped or renamed out from under the resolver", async () => {
		const { rows } = await db.query(
			`select data_type, is_nullable from information_schema.columns
			 where table_name = 'vendors' and column_name = 'letterstory_org_id'`,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
	});
});
