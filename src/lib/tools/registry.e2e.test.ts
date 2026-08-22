import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/core";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * registry.test.ts exercises dispatchTool's membership/capability gate
 * against an in-memory fake `.from().eq().eq().maybeSingle()` chain — it
 * proves the code issues the right query, not that the query matches
 * `vendor_members`'s real schema (column names, uuid typing, the
 * (vendor_id, user_id) primary key it filters on). This file runs the same
 * `dispatchTool`, unmodified, against a real (embedded, WASM) Postgres with
 * the actual migrations applied — same technique as
 * src/app/api/vendor/onboarding/route.schema.test.ts — so a schema drift
 * (a renamed column, a type mismatch) fails here instead of at the first
 * live bearer-token call.
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
		"insert into vendors (id, slug, name, domain, category, key) values ($1, 'e2e-acme', 'E2E Acme', 'e2e-acme.example', 'test', 'lp_live_e2e_acme')",
		[VENDOR_ID],
	);
	// Only MEMBER_USER_ID is actually a member — OUTSIDER_USER_ID exists as a
	// real user but has no row here, which is what the negative case relies on.
	await pg.query("insert into vendor_members (vendor_id, user_id) values ($1, $2)", [VENDOR_ID, MEMBER_USER_ID]);
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
					const { rows } = await pg.query(
						`select ${state.columns} from ${table}${where ? ` where ${where}` : ""} limit 1`,
						params,
					);
					return { data: rows[0] ?? null, error: null };
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
	it("sends a real vendor's support message, over the real membership check and the real webhook call", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("submit_support_request", { message: "help please" }, principal(MEMBER_USER_ID));

		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { ok: true } } });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://hooks.example.com/support");
		const body = JSON.parse((init as { body: string }).body);
		expect(body.text).toContain("E2E Acme (e2e-acme)");
		expect(body.text).toContain(`${MEMBER_USER_ID}@example.com`);
		expect(body.text).toContain("help please");
	});

	// The generic vendor:* membership gate lives in dispatchTool and is shared
	// by every vendor:write tool — this proves it actually rejects a real,
	// existing user who just isn't in vendor_members for this vendor, not only
	// the in-memory fake registry.test.ts uses for the same check.
	it("denies a real user who isn't a vendor_members row for this vendor, before the handler runs", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("submit_support_request", { message: "help please" }, principal(OUTSIDER_USER_ID));

		expect(outcome).toEqual({ kind: "denied", capability: "vendor:write" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
