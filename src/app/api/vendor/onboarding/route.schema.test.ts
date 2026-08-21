import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient: vi.fn() }));

/**
 * route.test.ts mocks the Supabase client entirely — `insert()` always
 * resolves `{ error: null }` — so it cannot see anything Postgres itself
 * would do to a row: apply a default, reject a null, enforce a unique
 * constraint. That's exactly how `domain_verification_token` shipped with no
 * default and stayed untested (see 20260821051500's fix and its migration):
 * every self-serve vendor's `domain_verification_token` came back `null`,
 * and every verify surface 409'd forever, while this suite's mocked
 * equivalent stayed green.
 *
 * This file runs the real migrations against a real (embedded, WASM)
 * Postgres — no Docker, no network, no secrets, so it's safe for the
 * no-DB-credentials CI job — and drives the actual `POST` handler against
 * it, so a future migration that removes a default or adds a required
 * column fails here instead of at the first production signup.
 */

const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";

let db: PGlite;

beforeAll(async () => {
	db = new PGlite();

	// Supabase-specific bits the raw migration files assume exist: the
	// `anon`/`authenticated`/`service_role` grantees, and `auth.users` for
	// the `vendor_members` FK. RLS itself isn't exercised — this suite's
	// concern is schema defaults/constraints, not authorization, and the
	// harness below runs as the bootstrap superuser (RLS-exempt) same as it
	// would need a session-bound `auth.uid()` to test meaningfully.
	await db.exec(`
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
		await db.exec(readFileSync(join(dir, f), "utf8"));
	}

	// vendor_members.user_id references auth.users — real signup gets this row
	// from GoTrue; here it has to exist before insertVendor()'s membership
	// insert can satisfy the FK.
	await db.query("insert into auth.users (id) values ($1)", [TEST_USER_ID]);
});

afterAll(async () => {
	await db.close();
});

/** A `.from(table).insert(row)` shim backed by the real pglite Postgres instead of a mock. */
function pgliteSupabase(userId: string) {
	return {
		auth: { getUser: async () => ({ data: { user: { id: userId } } }) },
		from(table: string) {
			return {
				insert: async (row: Record<string, unknown>) => {
					const columns = Object.keys(row);
					const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
					try {
						await db.query(
							`insert into ${table} (${columns.join(", ")}) values (${placeholders})`,
							columns.map((c) => row[c]),
						);
						return { error: null };
					} catch (e) {
						// Real Postgres errors carry the real SQLSTATE, so insertVendor()'s
						// `error.code === "23505"` unique-violation check exercises for real.
						const pgErr = e as { code?: string; message: string };
						return { error: { code: pgErr.code, message: pgErr.message } };
					}
				},
			};
		},
	};
}

function req(body: unknown) {
	return new NextRequest("https://app.letterprove.com/api/vendor/onboarding", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(async () => {
	vi.clearAllMocks();
	const { createServerSupabaseClient } = await import("@/lib/auth/server");
	vi.mocked(createServerSupabaseClient).mockResolvedValue(pgliteSupabase(TEST_USER_ID) as never);
});

describe("POST /api/vendor/onboarding, against a real Postgres schema", () => {
	it("gives a brand-new self-serve vendor a usable (non-null) verification token", async () => {
		const res = await POST(
			req({ name: "Regression Co", domain: "regression-co.example", category: "test" }),
		);
		expect(res.status).toBe(303);

		const { rows } = await db.query(
			"select domain_verification_token, domain_verified_at from vendors where slug = 'regression-co'",
		);
		expect(rows).toHaveLength(1);
		const row = rows[0] as { domain_verification_token: string | null; domain_verified_at: string | null };

		// This is the exact assertion PR #84 fixed: before it, the column had
		// no default, so a fresh insert left it null and every verify surface
		// (dashboard, API, CLI) 409'd with no_verification_token, permanently.
		expect(row.domain_verification_token).not.toBeNull();
		expect(row.domain_verification_token).toMatch(/^[0-9a-f]{32}$/);
		expect(row.domain_verified_at).toBeNull();
	});

	it("guards the whole class: every NOT NULL, no-default column on vendors is one insertVendor() actually supplies", async () => {
		// Generalizes the fix above beyond this one column — if a future
		// migration adds a required column that insertVendor() doesn't know
		// about, this fails at test time instead of at the first signup.
		const suppliedByInsertVendor = new Set(["id", "slug", "name", "domain", "category", "key"]);
		const { rows } = await db.query(
			`select column_name from information_schema.columns
			 where table_name = 'vendors' and is_nullable = 'NO' and column_default is null`,
		);
		for (const { column_name } of rows as { column_name: string }[]) {
			expect(
				suppliedByInsertVendor.has(column_name),
				`vendors.${column_name} is NOT NULL with no default, but insertVendor() doesn't set it`,
			).toBe(true);
		}
	});
});
