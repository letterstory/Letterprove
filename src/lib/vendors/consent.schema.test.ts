import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * consent.test.ts mocks dbClient() entirely, so it can't see anything real
 * Postgres does to a row: enforce the partial unique index on consent_token,
 * apply the scoped UPDATE...WHERE...RETURNING semantics recordConsentDecision
 * depends on for its race-safety, or reject a malformed value. Same rationale
 * as route.schema.test.ts (PR #87) — this replays the real migrations into an
 * embedded pglite Postgres and drives the real service functions and the real
 * POST /consent/respond handler against it.
 */

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/rollup/snapshots", () => ({ currentSnapshot: vi.fn() }));

let db: PGlite;

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
});

afterAll(async () => {
	await db.close();
});

/**
 * A minimal `.from(table)` query-builder shim backed by the real pglite
 * Postgres, covering exactly the chains consent.ts and generateConsentLink
 * use: select/eq/gt/maybeSingle, and update/eq/gt/select/maybeSingle. Errors
 * from Postgres (unique violation, etc.) come back with the real SQLSTATE, so
 * `error.code` checks in the real code exercise for real.
 */
function pgliteClient() {
	return {
		from(table: string) {
			const wheres: { col: string; op: string; val: unknown }[] = [];
			let mode: "select" | "update" | null = null;
			let selectCols = "*";
			let updatePatch: Record<string, unknown> | null = null;
			let returningCols = "id";

			const builder = {
				select(cols: string) {
					if (mode === "update") {
						returningCols = cols;
						return builder;
					}
					mode = "select";
					selectCols = cols;
					return builder;
				},
				update(patch: Record<string, unknown>) {
					mode = "update";
					updatePatch = patch;
					return builder;
				},
				eq(col: string, val: unknown) {
					wheres.push({ col, op: "=", val });
					return builder;
				},
				gt(col: string, val: unknown) {
					wheres.push({ col, op: ">", val });
					return builder;
				},
				async maybeSingle() {
					if (mode === "select") {
						const clause = wheres.map((w, i) => `${w.col} ${w.op} $${i + 1}`).join(" and ");
						const { rows } = await db.query(
							`select ${selectCols} from ${table} where ${clause}`,
							wheres.map((w) => w.val),
						);
						return { data: rows[0] ?? null, error: null };
					}

					const setCols = Object.keys(updatePatch!);
					const setClause = setCols.map((c, i) => `${c} = $${i + 1}`).join(", ");
					const setParams = setCols.map((c) => updatePatch![c]);
					const offset = setParams.length;
					const whereClause = wheres.map((w, i) => `${w.col} ${w.op} $${offset + i + 1}`).join(" and ");
					const params = [...setParams, ...wheres.map((w) => w.val)];
					try {
						const { rows } = await db.query(
							`update ${table} set ${setClause} where ${whereClause} returning ${returningCols}`,
							params,
						);
						return { data: rows[0] ?? null, error: null };
					} catch (e) {
						const pgErr = e as { code?: string; message: string };
						return { data: null, error: { code: pgErr.code, message: pgErr.message } };
					}
				},
			};
			return builder;
		},
	};
}

async function seedVendorAndCustomer(overrides: {
	consentToken?: string | null;
	consentTokenExpiresAt?: string | null;
	countersignedAt?: string | null;
	consentSentTo?: string | null;
}) {
	const vendorId = randomUUID();
	const customerId = randomUUID();
	const vendorSlug = `vendor-${vendorId.slice(0, 8)}`;
	const customerSlug = `customer-${customerId.slice(0, 8)}`;

	await db.query("insert into vendors (id, slug, name, domain, category, key) values ($1, $2, $3, $4, $5, $6)", [
		vendorId,
		vendorSlug,
		"Regression Vendor",
		"regression-vendor.example",
		"test",
		`key-${vendorId}`,
	]);
	await db.query(
		`insert into vendor_customers
			(id, vendor_id, slug, name, domain, since, features, consent_token, consent_token_expires_at, countersigned_at, consent_sent_to)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		[
			customerId,
			vendorId,
			customerSlug,
			"Acme Regression",
			"acme-regression.example",
			"2026-01-01",
			["sso"],
			overrides.consentToken ?? null,
			overrides.consentTokenExpiresAt ?? null,
			overrides.countersignedAt ?? null,
			overrides.consentSentTo ?? null,
		],
	);

	return { vendorId, customerId, vendorSlug, customerSlug };
}

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteClient() as never);
	const { currentSnapshot } = await import("@/rollup/snapshots");
	vi.mocked(currentSnapshot).mockResolvedValue({
		observed_through: null,
		published_at: null,
		sessions_30d: 42,
		seats_active: 7,
		observed: true,
		readOk: true,
	} as never);
});

describe("customer consent/countersign, against a real Postgres schema", () => {
	it("generateConsentLink writes a real token, expiry and recipient onto the real row", async () => {
		const { generateConsentLink } = await import("./customers");
		const { vendorId, customerSlug, customerId } = await seedVendorAndCustomer({});

		const result = await generateConsentLink(
			pgliteClient() as never,
			vendorId,
			customerSlug,
			"ops@acme-regression.example",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const { rows } = await db.query(
			"select consent_token, consent_token_expires_at, consent_sent_to from vendor_customers where id = $1",
			[customerId],
		);
		const row = rows[0] as {
			consent_token: string;
			consent_token_expires_at: string;
			consent_sent_to: string;
		};
		expect(row.consent_token).toBe(result.data.token);
		expect(new Date(row.consent_token_expires_at).toISOString()).toBe(result.data.expiresAt);
		expect(row.consent_sent_to).toBe("ops@acme-regression.example");
		expect(result.data.customerName).toBe("Acme Regression");
	});

	/*
	 * The binding, proven against the real schema rather than a mock: the
	 * domain is read from the stored customer row, so a vendor cannot supply
	 * both sides of the comparison. Without this, a vendor mails themselves the
	 * link and countersigns their own attestation — and earned() promotes that
	 * to tier 4 ahead of the domain-verified and observed gates.
	 */
	it("generateConsentLink refuses an address off the customer's domain, and writes nothing", async () => {
		const { generateConsentLink } = await import("./customers");
		const { vendorId, customerSlug, customerId } = await seedVendorAndCustomer({});

		const result = await generateConsentLink(
			pgliteClient() as never,
			vendorId,
			customerSlug,
			"me@regression-vendor.example",
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(422);

		const { rows } = await db.query(
			"select consent_token, consent_sent_to from vendor_customers where id = $1",
			[customerId],
		);
		const row = rows[0] as { consent_token: string | null; consent_sent_to: string | null };
		expect(row.consent_token).toBeNull();
		expect(row.consent_sent_to).toBeNull();
	});

	it("clearConsentToken rolls back only the exact token it was given", async () => {
		const { clearConsentToken } = await import("./customers");
		const { vendorId, customerSlug, customerId } = await seedVendorAndCustomer({
			consentToken: "live-token",
			consentTokenExpiresAt: new Date(Date.now() + 1000_000).toISOString(),
			consentSentTo: "ops@acme-regression.example",
		});

		// A stale token from an earlier, already-superseded mint must not wipe the
		// live one that replaced it.
		await clearConsentToken(pgliteClient() as never, vendorId, customerSlug, "some-older-token");
		let { rows } = await db.query("select consent_token from vendor_customers where id = $1", [customerId]);
		expect((rows[0] as { consent_token: string | null }).consent_token).toBe("live-token");

		await clearConsentToken(pgliteClient() as never, vendorId, customerSlug, "live-token");
		({ rows } = await db.query("select consent_token, consent_sent_to from vendor_customers where id = $1", [
			customerId,
		]));
		const row = rows[0] as { consent_token: string | null; consent_sent_to: string | null };
		expect(row.consent_token).toBeNull();
		expect(row.consent_sent_to).toBeNull();
	});

	it("the partial unique index rejects two live rows sharing one consent_token", async () => {
		const first = await seedVendorAndCustomer({
			consentToken: "shared-token",
			consentTokenExpiresAt: new Date(Date.now() + 1000_000).toISOString(),
		});
		await expect(
			db.query(
				`insert into vendor_customers (id, vendor_id, slug, name, domain, since, consent_token, consent_token_expires_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8)`,
				[
					randomUUID(),
					first.vendorId,
					"another-customer",
					"Another Co",
					"another.example",
					"2026-01-01",
					"shared-token",
					new Date(Date.now() + 1000_000).toISOString(),
				],
			),
		).rejects.toMatchObject({ code: "23505" });
	});

	it("lookupConsentRequest reads real column state end to end: invalid, expired, ready, already_countersigned", async () => {
		const { lookupConsentRequest } = await import("./consent");

		const noToken = await seedVendorAndCustomer({});
		expect(await lookupConsentRequest(noToken.vendorSlug, noToken.customerSlug, "anything")).toEqual({
			status: "invalid",
		});

		const expired = await seedVendorAndCustomer({
			consentToken: "tok-expired",
			consentTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
		});
		expect(await lookupConsentRequest(expired.vendorSlug, expired.customerSlug, "tok-expired")).toEqual({
			status: "expired",
		});

		const ready = await seedVendorAndCustomer({
			consentToken: "tok-ready",
			consentTokenExpiresAt: new Date(Date.now() + 1000_000).toISOString(),
		});
		const readyResult = await lookupConsentRequest(ready.vendorSlug, ready.customerSlug, "tok-ready");
		expect(readyResult.status).toBe("ready");
		if (readyResult.status === "ready") {
			expect(readyResult.preview.customerName).toBe("Acme Regression");
			expect(readyResult.preview.sessions30d).toBe(42);
		}

		const done = await seedVendorAndCustomer({ countersignedAt: new Date().toISOString() });
		expect(await lookupConsentRequest(done.vendorSlug, done.customerSlug, "whatever")).toEqual({
			status: "already_countersigned",
			customerName: "Acme Regression",
		});
	});

	it("recordConsentDecision(approve) sets countersigned_at and clears the token on the real row, and the scoped update blocks replay", async () => {
		const { recordConsentDecision } = await import("./consent");
		const { vendorSlug, customerSlug, customerId } = await seedVendorAndCustomer({
			consentToken: "tok-approve",
			consentTokenExpiresAt: new Date(Date.now() + 1000_000).toISOString(),
			consentSentTo: "ops@acme-regression.example",
		});

		const first = await recordConsentDecision(vendorSlug, customerSlug, "tok-approve", "approve");
		expect(first).toEqual({ ok: true });

		const { rows } = await db.query(
			"select consent, countersigned_at, countersigned_by, consent_token, consent_sent_to from vendor_customers where id = $1",
			[customerId],
		);
		const row = rows[0] as {
			consent: string;
			countersigned_at: string | null;
			countersigned_by: string | null;
			consent_token: string | null;
			consent_sent_to: string | null;
		};
		expect(row.consent).toBe("named");
		expect(row.countersigned_at).not.toBeNull();
		expect(row.consent_token).toBeNull();

		// Provenance: countersigned_at says a customer approved, countersigned_by
		// says which address did. Carried over from the delivery record, which is
		// then cleared along with the token — the link is spent either way.
		expect(row.countersigned_by).toBe("ops@acme-regression.example");
		expect(row.consent_sent_to).toBeNull();

		// Replaying the same (now-cleared) token must not re-run the update —
		// this is the scoped eq(consent_token, token) chain doing its job as
		// the sole authorization check, not a redundant belt-and-suspenders.
		const replay = await recordConsentDecision(vendorSlug, customerSlug, "tok-approve", "approve");
		expect(replay).toEqual({ ok: false, reason: "invalid" });
	});

	it("recordConsentDecision(decline) clears the token but never sets countersigned_at", async () => {
		const { recordConsentDecision } = await import("./consent");
		const { vendorSlug, customerSlug, customerId } = await seedVendorAndCustomer({
			consentToken: "tok-decline",
			consentTokenExpiresAt: new Date(Date.now() + 1000_000).toISOString(),
		});

		const result = await recordConsentDecision(vendorSlug, customerSlug, "tok-decline", "decline");
		expect(result).toEqual({ ok: true });

		const { rows } = await db.query("select consent, countersigned_at, consent_token from vendor_customers where id = $1", [
			customerId,
		]);
		const row = rows[0] as { consent: string; countersigned_at: string | null; consent_token: string | null };
		expect(row.consent).toBe("anonymous");
		expect(row.countersigned_at).toBeNull();
		expect(row.consent_token).toBeNull();
	});

	it("drives the real POST /consent/respond handler over a real NextRequest against the real DB", async () => {
		const { POST } = await import("../../app/attest/[vendor]/[customer]/consent/respond/route");
		const { vendorSlug, customerSlug, customerId } = await seedVendorAndCustomer({
			consentToken: "tok-http",
			consentTokenExpiresAt: new Date(Date.now() + 1000_000).toISOString(),
		});

		const body = new URLSearchParams({ token: "tok-http", decision: "approve" });
		const res = await POST(
			new NextRequest(`https://app.letterprove.com/attest/${vendorSlug}/${customerSlug}/consent/respond`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			}),
			{ params: Promise.resolve({ vendor: vendorSlug, customer: customerSlug }) },
		);

		expect(res.status).toBe(307);
		const location = new URL(res.headers.get("location")!);
		expect(location.searchParams.get("done")).toBe("approve");

		const { rows } = await db.query("select countersigned_at from vendor_customers where id = $1", [customerId]);
		expect((rows[0] as { countersigned_at: string | null }).countersigned_at).not.toBeNull();
	});
});
