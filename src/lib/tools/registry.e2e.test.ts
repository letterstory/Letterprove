import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * registry.test.ts exercises dispatchTool's membership/capability gate
 * against an in-memory fake `.from().eq().eq().maybeSingle()` chain — it
 * proves the code issues the right query, not what that query resolves to
 * against real Postgres. This file runs the same `dispatchTool`, unmodified,
 * against a real (embedded, WASM) Postgres with the actual migrations
 * applied — same technique as
 * src/app/api/vendor/onboarding/route.schema.test.ts — so a schema drift
 * fails here instead of at the first live bearer-token call.
 *
 * 20260828130000_unify_auth_drop_local_identity.sql drops `vendor_members`
 * entirely — membership now lives only in Letterstory. The gate in
 * registry.ts that queries it (only reachable when `principal.orgId` is
 * unset, i.e. a bearer token minted before the retirement, or any future
 * non-service caller) is kept as a defensive fallback rather than deleted, so
 * this now proves what it actually does against the real schema: the query
 * against a table that doesn't exist errors, and the gate treats that as "no
 * membership" and denies — not what it did before, but still fails safe.
 *
 * Two boundaries stay faked, both non-Postgres: the Supabase Auth Admin API
 * (`auth.admin.getUserById` is a GoTrue REST call, not a SQL query) and the
 * outbound Slack webhook fetch (external network) — the same boundary
 * slack.test.ts already fakes, for the same reason.
 */

const VENDOR_ID = "22222222-2222-2222-2222-222222222222";
const MEMBER_USER_ID = "11111111-1111-1111-1111-111111111111";
const OUTSIDER_USER_ID = "33333333-3333-3333-3333-333333333333";

let pg: PGlite;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
	pg = new PGlite();

	// Supabase-specific bits the raw migration files assume exist — see
	// route.schema.test.ts's identical setup for why.
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

	await pg.query("insert into auth.users (id) values ($1), ($2)", [MEMBER_USER_ID, OUTSIDER_USER_ID]);
	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key, letterstory_org_id) values ($1, 'e2e-acme', 'E2E Acme', 'e2e-acme.example', 'test', 'lp_live_e2e_acme', gen_random_uuid())",
		[VENDOR_ID],
	);
	// No vendor_members insert: the table doesn't exist post-unification.
	// Both user ids below are just real, distinct auth.users rows now — neither
	// can be "a member" of anything, which is exactly the point.
});

afterAll(async () => {
	await pg.close();
});

/** A `.from(table).select(cols).eq(...).maybeSingle()` shim backed by the real pglite Postgres. */
function pgliteSupabase() {
	return {
		auth: {
			admin: {
				getUserById: vi.fn(async (id: string) => ({ data: { user: { id, email: `${id}@example.com` } }, error: null })),
			},
		},
		from(table: string) {
			const state: { columns: string; filters: [string, unknown][] } = { columns: "*", filters: [] };
			const builder = {
				select(columns: string) {
					state.columns = columns;
					return builder;
				},
				eq(column: string, value: unknown) {
					state.filters.push([column, value]);
					return builder;
				},
				async maybeSingle() {
					const where = state.filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
					const params = state.filters.map(([, v]) => v);
					// A real Supabase client resolves a query error into { error }
					// rather than throwing — most vividly here, where the table
					// itself no longer exists. pg.query throws instead, so that
					// gets converted here to keep the shim honest to what
					// registry.ts's `if (!membership)` check actually sees.
					try {
						const { rows } = await pg.query(
							`select ${state.columns} from ${table}${where ? ` where ${where}` : ""} limit 1`,
							params,
						);
						return { data: rows[0] ?? null, error: null };
					} catch (error) {
						return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
					}
				},
			};
			return builder;
		},
	};
}

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase() as never);

	fetchMock = vi.fn().mockResolvedValue({ ok: true });
	vi.stubGlobal("fetch", fetchMock);
	process.env.SUPPORT_SLACK_WEBHOOK_URL = "https://hooks.example.com/support";
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.SUPPORT_SLACK_WEBHOOK_URL;
});

function principal(userId: string): OAuthPrincipal {
	return { tokenId: "t1", vendorId: VENDOR_ID, userId, capabilities: ["vendor:write"] };
}

describe("submit_support_request against a real Postgres schema", () => {
	// The generic vendor:* membership gate lives in dispatchTool and is shared
	// by every vendor:write tool. Before the unification, this proved it let a
	// real vendor_members row through and rejected a real user who wasn't one.
	// Now the table is gone, so both users are denied identically — the case
	// worth pinning is that the gate errors safe against real Postgres rather
	// than throwing an uncaught error up through dispatchTool.
	it.each([
		["a user who would have been a member before the unification", MEMBER_USER_ID],
		["a user who was never a member", OUTSIDER_USER_ID],
	])("denies %s, because vendor_members no longer exists to check", async (_label, userId) => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("submit_support_request", { message: "help please" }, principal(userId));

		expect(outcome).toEqual({ kind: "denied", capability: "vendor:write" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
