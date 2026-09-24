import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * observe/route.test.ts mocks findVendorByKey and recordObservation entirely
 * — it proves the route calls the right functions with the right shape, not
 * that the domain-verification refusal (the "load-bearing" check per
 * SetupSteps.tsx's own comment, and the test plan's A2 negative) actually
 * holds against the real `vendors.domain_verified_at` column, or that an
 * accepted event actually lands a real row in `hot_events`. This drives the
 * real POST handler, real findVendorByKey, and real recordObservation
 * against a real (embedded, WASM) Postgres with the actual migrations
 * applied — same technique as the other *.e2e.test.ts files in this repo.
 *
 * Rate limiting is deliberately mocked out here (it has its own coverage in
 * oauth/ratelimit.test.ts and observe/route.test.ts) so this file stays
 * focused on the one thing nothing else proves against the real schema: the
 * domain-verification gate.
 */

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/oauth/ratelimit", () => ({ oauthRateLimit: vi.fn().mockResolvedValue(true), oauthClientIp: vi.fn(() => "203.0.113.9") }));

let pg: PGlite;

const VERIFIED_VENDOR_ID = "44444444-4444-4444-4444-444444444444";
const UNVERIFIED_VENDOR_ID = "55555555-5555-5555-5555-555555555555";

beforeAll(async () => {
	pg = new PGlite();

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

	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verified_at)
		 values ($1, 'e2e-observe-verified', 'E2E Observe Verified', 'observe-verified.example', 'test', 'lp_live_e2e_observe_verified', gen_random_uuid(), now())`,
		[VERIFIED_VENDOR_ID],
	);
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verified_at)
		 values ($1, 'e2e-observe-unverified', 'E2E Observe Unverified', 'observe-unverified.example', 'test', 'lp_live_e2e_observe_unverified', gen_random_uuid(), null)`,
		[UNVERIFIED_VENDOR_ID],
	);
});

afterAll(async () => {
	await pg.close();
});

/** `.from(table).select(cols).eq(...).maybeSingle()` / plain awaited select-list / awaited insert — enough of the Supabase surface for findVendorByKey + recordObservation, unmodified. */
function pgliteSupabase() {
	return {
		from(table: string) {
			const state: { columns: string; filters: [string, unknown][]; insertRow?: Record<string, unknown> } = {
				columns: "*",
				filters: [],
			};

			async function runInsert() {
				const cols = Object.keys(state.insertRow!);
				const placeholders = cols.map((_, i) => `$${i + 1}`);
				try {
					await pg.query(
						`insert into ${table} (${cols.join(", ")}) values (${placeholders.join(", ")})`,
						Object.values(state.insertRow!),
					);
					return { data: null, error: null };
				} catch (e: unknown) {
					const err = e as { message?: string };
					return { data: null, error: { message: String(err.message ?? e) } };
				}
			}

			async function runSelectList() {
				const where = state.filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
				const { rows } = await pg.query(
					`select ${state.columns} from ${table}${where ? ` where ${where}` : ""}`,
					state.filters.map(([, v]) => v),
				);
				return { data: rows, error: null };
			}

			const builder = {
				select(columns: string) {
					state.columns = columns;
					return builder;
				},
				insert(row: Record<string, unknown>) {
					state.insertRow = row;
					return builder;
				},
				eq(column: string, value: unknown) {
					state.filters.push([column, value]);
					return builder;
				},
				async maybeSingle() {
					const where = state.filters.map(([c], i) => `${c} = $${i + 1}`).join(" and ");
					const { rows } = await pg.query(
						`select ${state.columns} from ${table}${where ? ` where ${where}` : ""} limit 1`,
						state.filters.map(([, v]) => v),
					);
					return { data: rows[0] ?? null, error: null };
				},
				then<T>(onFulfilled: (v: { data: unknown; error: unknown }) => T, onRejected?: (e: unknown) => T) {
					const p = state.insertRow ? runInsert() : runSelectList();
					return p.then(onFulfilled, onRejected);
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
	const { oauthRateLimit } = await import("@/lib/oauth/ratelimit");
	vi.mocked(oauthRateLimit).mockResolvedValue(true);
});

async function hotEventCount(vendorSlug: string): Promise<number> {
	const { rows } = await pg.query<{ count: string }>("select count(*) from hot_events where vendor_slug = $1", [
		vendorSlug,
	]);
	return Number(rows[0].count);
}

async function post(key: string, domain: string, origin: string) {
	const { POST } = await import("./route");
	return POST(
		new Request("https://app.letterprove.com/api/v1/observe", {
			method: "POST",
			headers: { "content-type": "text/plain", origin },
			body: JSON.stringify({ k: key, domain, ev: "session", cfg: 1, ts: Math.floor(Date.now() / 1000) }),
		}),
	);
}

describe("POST /api/v1/observe against a real Postgres schema", () => {
	it("refuses an event for a vendor who has not proven domain control, and writes nothing", async () => {
		const res = await post("lp_live_e2e_observe_unverified", "acme.com", "https://observe-unverified.example");

		expect(res.status).toBe(204);
		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(await hotEventCount("e2e-observe-unverified")).toBe(0);
	});

	it("accepts and records a real row once the same vendor is verified", async () => {
		const res = await post("lp_live_e2e_observe_verified", "acme.com", "https://observe-verified.example");

		expect(res.status).toBe(204);
		expect(res.headers.get("x-letterprove")).toBe("on");
		expect(await hotEventCount("e2e-observe-verified")).toBe(1);

		const { rows } = await pg.query<{ domain: string; ev: string }>(
			"select domain, ev from hot_events where vendor_slug = $1",
			["e2e-observe-verified"],
		);
		expect(rows[0]).toMatchObject({ domain: "acme.com", ev: "session" });
	});
});
