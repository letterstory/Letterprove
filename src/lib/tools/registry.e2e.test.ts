import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/email/consent", () => ({ sendConsentRequest: vi.fn() }));

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

/** A `.from(table).select(cols).eq(...).update(...).maybeSingle()` shim backed by the real pglite Postgres. */
function pgliteSupabase() {
	return {
		auth: {
			admin: {
				getUserById: vi.fn(async (id: string) => ({ data: { user: { id, email: `${id}@example.com` } }, error: null })),
			},
		},
		from(table: string) {
			const state: { columns: string; filters: [string, unknown][]; updatePatch?: Record<string, unknown> } = {
				columns: "*",
				filters: [],
			};
			const builder = {
				select(columns: string) {
					state.columns = columns;
					return builder;
				},
				eq(column: string, value: unknown) {
					state.filters.push([column, value]);
					return builder;
				},
				update(patch: Record<string, unknown>) {
					state.updatePatch = patch;
					return builder;
				},
				async maybeSingle() {
					// A real Supabase client resolves a query error into { error }
					// rather than throwing — most vividly here, where the table
					// itself no longer exists. pg.query throws instead, so that
					// gets converted here to keep the shim honest to what
					// registry.ts's `if (!membership)` check actually sees.
					try {
						if (state.updatePatch) {
							const cols = Object.keys(state.updatePatch);
							const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
							const whereClause = state.filters.map(([c], i) => `${c} = $${cols.length + i + 1}`).join(" and ");
							const { rows } = await pg.query(
								`update ${table} set ${setClause}${whereClause ? ` where ${whereClause}` : ""} returning ${state.columns}`,
								[...Object.values(state.updatePatch), ...state.filters.map(([, v]) => v)],
							);
							return { data: rows[0] ?? null, error: null };
						}
						const where = state.filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
						const params = state.filters.map(([, v]) => v);
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

// Mirrors authenticateToolRequest's real, post-unification shape: a
// Letterstory-service call carries BOTH orgId (so dispatchTool skips the now
// -dead vendor_members gate) and vendorId (already resolved via
// findVendorByOrg). principal() above is deliberately the pre-unification
// shape — vendorId with no orgId — because that's what registry.e2e's own
// tests are proving still fails safe now that vendor_members is gone.
function serviceCallerFor(vendorId: string): OAuthPrincipal {
	return {
		tokenId: "letterstory-service",
		vendorId,
		userId: "letterstory-service",
		capabilities: ["vendor:read", "vendor:write"],
		orgId: "e2e-org",
	};
}

describe("request_consent's rollback-on-email-failure, against a real Postgres schema", () => {
	// registry.test.ts (mocked) already proves clearConsentToken is CALLED
	// with the right args when the send fails — it can't prove the row it
	// names actually still holds a live token beforehand, or that it's
	// really gone after. This drives the real dispatchTool -> generateConsentLink
	// -> (failed) sendConsentRequest -> clearConsentToken chain against a real
	// row, so the rollback is proven as a DB effect, not a mocked call.
	it("mints a real token, then rolls it back for real when the send fails", async () => {
		const { dispatchTool } = await import("./registry");
		const { sendConsentRequest } = await import("@/lib/email/consent");
		vi.mocked(sendConsentRequest).mockResolvedValue({ ok: false, error: "Couldn't send the consent email." });

		const customerId = randomUUID();
		await pg.query(
			`insert into vendor_customers (id, vendor_id, slug, name, domain, since, features)
			 values ($1, $2, 'rollback-e2e', 'Rollback Co', 'rollback-e2e.example', '2024-01', '{}')`,
			[customerId, VENDOR_ID],
		);

		const outcome = await dispatchTool(
			"request_consent",
			{ slug: "rollback-e2e", contact_email: "ops@rollback-e2e.example" },
			serviceCallerFor(VENDOR_ID),
			{ origin: "https://app.letterprove.com" },
		);

		expect(outcome).toMatchObject({ kind: "result", result: { ok: false, status: 502 } });

		// Proves generateConsentLink really minted something before the
		// rollback — otherwise "the token is null afterward" would be true
		// whether or not a rollback ever ran.
		const [sentArgs] = vi.mocked(sendConsentRequest).mock.calls[0];
		expect(sentArgs.url).toMatch(/token=\S+/);

		const { rows } = await pg.query<{ consent_token: string | null; consent_sent_to: string | null }>(
			"select consent_token, consent_sent_to from vendor_customers where id = $1",
			[customerId],
		);
		expect(rows[0].consent_token).toBeNull();
		expect(rows[0].consent_sent_to).toBeNull();
	});

	it("leaves the minted token live when the send succeeds — no rollback fires on the happy path", async () => {
		const { dispatchTool } = await import("./registry");
		const { sendConsentRequest } = await import("@/lib/email/consent");
		vi.mocked(sendConsentRequest).mockResolvedValue({ ok: true });

		const customerId = randomUUID();
		await pg.query(
			`insert into vendor_customers (id, vendor_id, slug, name, domain, since, features)
			 values ($1, $2, 'no-rollback-e2e', 'No Rollback Co', 'no-rollback-e2e.example', '2024-01', '{}')`,
			[customerId, VENDOR_ID],
		);

		const outcome = await dispatchTool(
			"request_consent",
			{ slug: "no-rollback-e2e", contact_email: "ops@no-rollback-e2e.example" },
			serviceCallerFor(VENDOR_ID),
			{ origin: "https://app.letterprove.com" },
		);

		expect(outcome).toMatchObject({ kind: "result", result: { ok: true } });

		const { rows } = await pg.query<{ consent_token: string | null }>(
			"select consent_token from vendor_customers where id = $1",
			[customerId],
		);
		expect(rows[0].consent_token).not.toBeNull();
	});
});

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
