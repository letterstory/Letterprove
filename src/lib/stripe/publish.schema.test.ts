import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
// The ONE faked boundary, and it is not Postgres: fetch.ts is an HTTP call to
// Stripe, already covered by its own tests. Everything downstream — mapping,
// the evidence write, reading it back, and the tier decision — runs for real.
vi.mock("./fetch", () => ({ fetchSubscriptions: vi.fn() }));

import { syncVendorPayments } from "./sync";
import { fetchSubscriptions } from "./fetch";
import { encryptStripeKey } from "./credentials";
import { paymentEvidenceFor } from "@/lib/attest/payment-evidence";
import { earned } from "@/lib/attest/body";

/**
 * Tier 3's PUBLISH half, against the real schema.
 *
 * Why this file exists: measured on 2026-08-23, every attestation ever frozen
 * in production is tier 0 or tier 1, and `vendor_payment_evidence` has never
 * held a single row — all time. That is not a bug (sync.ts deliberately stores
 * nothing from a test-mode key, and the only connected key is test mode), but
 * it means the entire write path had never executed outside mocked unit tests:
 * the evidence INSERT, reading it back through the bigint column, and earned()
 * actually returning 3.
 *
 * `livemode` is the only thing separating this from production. Everything
 * asserted below is byte-identical to what a real paying vendor would exercise,
 * so this closes the gap that a live Stripe account would otherwise be needed
 * for — short of Stripe itself setting the boolean, which fetch/credentials
 * tests already cover.
 *
 * sync.test.ts mocks the database, so it cannot see what Postgres does to these
 * rows: the composite primary key, the bigint typing that supabase-js hands
 * back as a string, or a constraint rejecting a write. That is the same class
 * of gap that shipped `domain_verification_token` with no default and, earlier
 * today, let the customers page drift off `CUSTOMER_COLUMNS`.
 */

const VENDOR_ID = randomUUID();
const VENDOR_SLUG = "tier3-probe";
// Fabricated and unregistered — no real company is named in a payment claim.
const PAYING_DOMAIN = "halcyon-drayage.com";

let pg: PGlite;

/** Supabase-shaped shim over real Postgres. Thenable, because sync.ts awaits the builder directly. */
function pgliteSupabase() {
	return {
		from(table: string) {
			let mode: "select" | "insert" | "update" | "delete" = "select";
			let columns = "*";
			let rows: Record<string, unknown>[] = [];
			let patch: Record<string, unknown> = {};
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
						return { rows: out, error: null };
					}
					if (mode === "delete") {
						const { rows: out } = await pg.query(`delete from ${table}${where()} returning *`, params());
						return { rows: out, error: null };
					}
					if (mode === "update") {
						const cols = Object.keys(patch);
						const set = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
						const { rows: out } = await pg.query(
							`update ${table} set ${set}${where(cols.length)} returning *`,
							[...cols.map((c) => patch[c]), ...params()],
						);
						return { rows: out, error: null };
					}
					const { rows: out } = await pg.query(`select ${columns} from ${table}${where()}`, params());
					return { rows: out, error: null };
				} catch (e) {
					const err = e as { code?: string; message: string };
					return { rows: [], error: { code: err.code, message: err.message } };
				}
			}

			const builder = {
				select(c: string) {
					if (mode === "select") columns = c;
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
				async maybeSingle() {
					const r = await run();
					return { data: r.rows[0] ?? null, error: r.error };
				},
				then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
					run().then((r) => resolve({ data: r.rows, error: r.error }), reject);
				},
			};
			return builder;
		},
	};
}

function subscription(over: Record<string, unknown> = {}) {
	return {
		id: "sub_probe_1",
		status: "active",
		start_date: Math.floor(Date.parse("2025-03-01T00:00:00Z") / 1000),
		currency: "usd",
		amount: 250000,
		interval: "month" as const,
		customerEmail: `billing@${PAYING_DOMAIN}`,
		...over,
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
		"insert into vendors (id, slug, name, domain, category, key) values ($1, $2, 'Tier3 Probe', 'tier3-probe.com', 'test', $3)",
		[VENDOR_ID, VENDOR_SLUG, `lp_live_${VENDOR_SLUG}`],
	);
	// The join sync.ts insists on: payment is only evidence about a company we
	// actually saw using the product.
	await pg.query(
		`insert into hot_rollups (vendor_slug, domain, window_start, sessions, signups, logins)
		 values ($1, $2, now() - interval '2 hours', 5, 1, 2)`,
		[VENDOR_SLUG, PAYING_DOMAIN],
	);
});

afterAll(async () => {
	await pg.close();
	delete process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY;
});

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase() as never);
	await pg.query("delete from vendor_payment_evidence where vendor_id = $1", [VENDOR_ID]);
	await pg.query("delete from vendor_payment_unmatched where vendor_id = $1", [VENDOR_ID]);
});

describe("tier 3 publish path, against a real Postgres schema", () => {
	it("a LIVE-mode sync writes payment evidence that survives the real columns", async () => {
		await setCredential(true);
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			subscriptions: [subscription()],
			truncated: false,
		});

		const result = await syncVendorPayments(VENDOR_ID, VENDOR_SLUG);
		expect(result).toMatchObject({ ok: true, matched: 1, unmatched: 0, testMode: false });

		const { rows } = await pg.query("select * from vendor_payment_evidence where vendor_id = $1", [VENDOR_ID]);
		expect(rows).toHaveLength(1);
		const row = rows[0] as Record<string, unknown>;
		expect(row.domain).toBe(PAYING_DOMAIN);
		expect(Number(row.monthly_amount)).toBe(250000);
		expect(row.currency).toBe("usd");
		expect(Number(row.subscription_count)).toBe(1);
	});

	it("normalises an annual subscription to a monthly figure through the bigint column", async () => {
		await setCredential(true);
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			// 1,200,000 minor units per YEAR.
			subscriptions: [subscription({ amount: 1_200_000, interval: "year" })],
			truncated: false,
		});

		await syncVendorPayments(VENDOR_ID, VENDOR_SLUG);

		const evidence = await paymentEvidenceFor(VENDOR_ID, PAYING_DOMAIN);
		expect(evidence).not.toBeNull();
		expect(evidence!.monthlyAmount).toBe(100_000);
		// The column is bigint, which supabase-js may hand back as a string.
		// payment-evidence.ts refuses a non-integer rather than rounding, so a
		// number here proves that conversion survived a real Postgres round trip.
		expect(Number.isSafeInteger(evidence!.monthlyAmount)).toBe(true);
	});

	/*
	 * The assertion this whole file exists for. earned() returning 3 has never
	 * happened in production — every frozen attestation, all time, is tier 0 or
	 * tier 1 — so until now it was only ever proven against a mock.
	 */
	it("earned() awards tier 3 from evidence read back out of the real table", async () => {
		await setCredential(true);
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			subscriptions: [subscription()],
			truncated: false,
		});
		await syncVendorPayments(VENDOR_ID, VENDOR_SLUG);

		const payment = await paymentEvidenceFor(VENDOR_ID, PAYING_DOMAIN);
		const customer = { tier: 1, verified: false, countersignedAt: null } as never;

		expect(earned(customer, true, true, payment)).toEqual({ tier: 3, verified: true });

		// Tier 3 sits BELOW the observed/domain-verified gates on purpose: money
		// proves a commercial relationship, not that the product was used.
		expect(earned(customer, false, true, payment)).toEqual({ tier: 0, verified: false });
		expect(earned(customer, true, false, payment)).toEqual({ tier: 0, verified: false });

		// And a counter-signature still outranks it.
		const countersigned = { tier: 1, verified: false, countersignedAt: "2026-08-23T00:00:00Z" } as never;
		expect(earned(countersigned, true, true, payment)).toEqual({ tier: 4, verified: true });
	});

	it("a cancelled subscription DISAPPEARS from evidence rather than lingering", async () => {
		await setCredential(true);
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			subscriptions: [subscription()],
			truncated: false,
		});
		await syncVendorPayments(VENDOR_ID, VENDOR_SLUG);
		expect(await paymentEvidenceFor(VENDOR_ID, PAYING_DOMAIN)).not.toBeNull();

		// Next sync: they stopped paying.
		vi.mocked(fetchSubscriptions).mockResolvedValue({ ok: true, subscriptions: [], truncated: false });
		await syncVendorPayments(VENDOR_ID, VENDOR_SLUG);

		// Replace-not-merge: a stale row would assert someone still pays when
		// they stopped, which is the worst kind of wrong for a signed claim.
		expect(await paymentEvidenceFor(VENDOR_ID, PAYING_DOMAIN)).toBeNull();
		const { rows } = await pg.query("select * from vendor_payment_evidence where vendor_id = $1", [VENDOR_ID]);
		expect(rows).toHaveLength(0);
	});

	it("records why an unmatched payment was rejected, so a vendor can fix it", async () => {
		await setCredential(true);
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			subscriptions: [
				subscription(),
				subscription({ id: "sub_free", customerEmail: "someone@gmail.com" }),
				subscription({ id: "sub_unseen", customerEmail: "ap@never-observed-probe.com" }),
			],
			truncated: false,
		});

		const result = await syncVendorPayments(VENDOR_ID, VENDOR_SLUG);
		expect(result).toMatchObject({ ok: true, matched: 1, unmatched: 2 });

		const { rows } = await pg.query(
			"select subscription_id, reason, domain from vendor_payment_unmatched where vendor_id = $1 order by subscription_id",
			[VENDOR_ID],
		);
		expect(rows).toEqual([
			{ subscription_id: "sub_free", reason: "not_a_company", domain: "gmail.com" },
			{ subscription_id: "sub_unseen", reason: "no_observed_traffic", domain: "never-observed-probe.com" },
		]);
	});

	it("a TEST-mode key stores nothing, however well its payments match", async () => {
		await setCredential(false);
		vi.mocked(fetchSubscriptions).mockResolvedValue({
			ok: true,
			subscriptions: [subscription()],
			truncated: false,
		});

		const result = await syncVendorPayments(VENDOR_ID, VENDOR_SLUG);

		// Still reports honestly, so a vendor wiring things up sees data flow…
		expect(result).toMatchObject({ ok: true, matched: 1, testMode: true });
		// …but evidence invented in test mode is not evidence.
		const { rows } = await pg.query("select * from vendor_payment_evidence where vendor_id = $1", [VENDOR_ID]);
		expect(rows).toHaveLength(0);
		expect(await paymentEvidenceFor(VENDOR_ID, PAYING_DOMAIN)).toBeNull();
	});
});
