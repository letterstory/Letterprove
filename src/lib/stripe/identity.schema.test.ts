import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
// The one faked boundary: fetch.ts is an HTTP call to Stripe, covered by its
// own tests. Everything downstream (recording the account, reading it back,
// and the tier decision) runs against real Postgres.
vi.mock("./fetch", () => ({ fetchAccount: vi.fn() }));

import { syncVendorStripe } from "./sync";
import { fetchAccount } from "./fetch";
import { encryptStripeKey } from "./credentials";
import { stripeBusiness, stripeBusinessConfirms } from "@/lib/attest/vendor-evidence";

/**
 * Tier 3 against the real schema, since 2026-10-14: Stripe confirms who the
 * vendor is and nothing else. sync.test.ts mocks the database, so it cannot
 * see that the columns the account read writes actually exist, or that the
 * evidence read gets back what was written.
 */

const VENDOR_ID = randomUUID();
const VENDOR_SLUG = "tier3-probe";

let pg: PGlite;

/** Supabase-shaped shim over real Postgres. Thenable, because sync.ts awaits the builder directly. */
function pgliteSupabase() {
	return {
		from(table: string) {
			let mode: "select" | "insert" | "update" | "delete" = "select";
			let columns = "*";
			let rows: Record<string, unknown>[] = [];
			let patch: Record<string, unknown> = {};
			// `select("*", { count: "exact", head: true })` asks for a row COUNT
			// and no rows. Modelled separately because paymentEvidenceCount reads
			// `count`, and a shim that answered with rows and no count would make
			// every vendor look unreadable rather than counted.
			let counting = false;
			const filters: [string, string, unknown][] = [];

			const where = (offset = 0) =>
				filters.length
					? " where " + filters.map(([c, op], i) => `${c} ${op} $${offset + i + 1}`).join(" and ")
					: "";
			const params = () => filters.map(([, , v]) => v);

			async function run() {
				try {
					if (mode === "insert") {
						const cols = Object.keys(rows[0]);
						const values = rows
							.map((_, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(", ")})`)
							.join(", ");
						const flat = rows.flatMap((row) => cols.map((c) => row[c]));
						const { rows: out } = await pg.query(
							`insert into ${table} (${cols.join(", ")}) values ${values} returning *`,
							flat,
						);
						return { rows: out, count: null, error: null };
					}
					if (mode === "delete") {
						const { rows: out } = await pg.query(`delete from ${table}${where()} returning *`, params());
						return { rows: out, count: null, error: null };
					}
					if (mode === "update") {
						const cols = Object.keys(patch);
						const set = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
						const { rows: out } = await pg.query(
							`update ${table} set ${set}${where(cols.length)} returning *`,
							[...cols.map((c) => patch[c]), ...params()],
						);
						return { rows: out, count: null, error: null };
					}
					if (counting) {
						const { rows: out } = await pg.query(
							`select count(*)::int as count from ${table}${where()}`,
							params(),
						);
						return { rows: [], count: (out[0] as { count: number }).count, error: null };
					}
					const { rows: out } = await pg.query(`select ${columns} from ${table}${where()}`, params());
					return { rows: out, count: null, error: null };
				} catch (e) {
					const err = e as { code?: string; message: string };
					return { rows: [], count: null, error: { code: err.code, message: err.message } };
				}
			}

			const builder = {
				select(c: string, opts?: { count?: string; head?: boolean }) {
					if (mode === "select") {
						columns = c;
						if (opts?.count) counting = true;
					}
					return builder;
				},
				insert(r: Record<string, unknown> | Record<string, unknown>[]) {
					mode = "insert";
					rows = Array.isArray(r) ? r : [r];
					return builder;
				},
				update(p: Record<string, unknown>) {
					mode = "update";
					patch = p;
					return builder;
				},
				delete() {
					mode = "delete";
					return builder;
				},
				eq(c: string, v: unknown) {
					filters.push([c, "=", v]);
					return builder;
				},
				gte(c: string, v: unknown) {
					filters.push([c, ">=", v]);
					return builder;
				},
				// Accepted and ignored: this shim answers the whole set in one page,
				// so ordering changes nothing about what comes back. Present because
				// the paged readers now chain through them.
				order() {
					return builder;
				},
				range: async (from: number, to: number) => {
					const r = await run();
					return { data: r.rows.slice(from, to + 1), error: r.error };
				},
				async maybeSingle() {
					const r = await run();
					return { data: r.rows[0] ?? null, error: r.error };
				},
				then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
					run().then((r) => resolve({ data: r.rows, count: r.count, error: r.error }), reject);
				},
			};
			return builder;
		},
	};
}

async function setCredential(livemode: boolean) {
	await pg.query("delete from vendor_stripe_credentials where vendor_id = $1", [VENDOR_ID]);
	await pg.query(
		`insert into vendor_stripe_credentials (vendor_id, encrypted_key, key_last4, livemode)
		 values ($1, $2, $3, $4)`,
		[VENDOR_ID, encryptStripeKey("rk_live_probe_key_value"), "alue", livemode],
	);
}

beforeAll(async () => {
	process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY = randomBytes(32).toString("base64");

	pg = new PGlite();
	await pg.exec(`
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
		await pg.exec(readFileSync(join(dir, f), "utf8"));
	}

	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key, letterstory_org_id) values ($1, $2, 'Tier3 Probe', 'tier3-probe.com', 'test', $3, gen_random_uuid())",
		[VENDOR_ID, VENDOR_SLUG, `lp_live_${VENDOR_SLUG}`],
	);
});

afterAll(async () => {
	await pg.close();
	delete process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY;
});

const ACCOUNT = {
	id: "acct_probe",
	domains: ["tier3-probe.com"],
	charges_enabled: true,
	business_name: "Tier3 Probe Inc.",
	country: "US",
	business_url_host: "tier3-probe.com",
};

beforeEach(async () => {
	vi.clearAllMocks();
	vi.mocked(fetchAccount).mockResolvedValue({ ok: true, account: { ...ACCOUNT } });
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase() as never);
});

describe("Stripe business identity, against a real Postgres schema", () => {
	it("records what a live account says about the business, and reads it back as verified", async () => {
		await setCredential(true);
		const result = await syncVendorStripe(VENDOR_ID, VENDOR_SLUG);
		expect(result).toMatchObject({ ok: true, bound: true, chargesEnabled: true, testMode: false });

		const business = await stripeBusiness(VENDOR_ID, "tier3-probe.com");
		expect(business).toEqual({
			verified: true,
			name: "Tier3 Probe Inc.",
			country: "US",
			website: "tier3-probe.com",
			website_matches_domain: true,
			binding: "domain_match",
		});
		expect(stripeBusinessConfirms(business)).toBe(true);
	});

	it("never verifies the business from a test key", async () => {
		await setCredential(false);
		await syncVendorStripe(VENDOR_ID, VENDOR_SLUG);
		const business = await stripeBusiness(VENDOR_ID, "tier3-probe.com");
		expect(business?.verified).toBe(false);
		expect(stripeBusinessConfirms(business)).toBe(false);
	});

	it("does not confirm a business Stripe hasn't verified", async () => {
		await setCredential(true);
		vi.mocked(fetchAccount).mockResolvedValue({ ok: true, account: { ...ACCOUNT, charges_enabled: false } });
		await syncVendorStripe(VENDOR_ID, VENDOR_SLUG);
		expect(stripeBusinessConfirms(await stripeBusiness(VENDOR_ID, "tier3-probe.com"))).toBe(false);
	});

	it("reads no payments and clears what the retired payment sync left behind", async () => {
		await setCredential(true);
		await pg.query(
			"insert into vendor_payment_evidence (vendor_id, domain, since, currency, monthly_amount, subscription_count, synced_at) values ($1, 'old.example', now(), 'usd', 100, 1, now())",
			[VENDOR_ID],
		);
		await syncVendorStripe(VENDOR_ID, VENDOR_SLUG);
		const { rows } = await pg.query("select * from vendor_payment_evidence where vendor_id = $1", [VENDOR_ID]);
		expect(rows).toHaveLength(0);
		expect(vi.mocked(fetchAccount)).toHaveBeenCalledTimes(1);
	});
});
