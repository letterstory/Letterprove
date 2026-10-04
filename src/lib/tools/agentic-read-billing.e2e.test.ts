import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * agentic_read_billing (recurring payments, half A — Letterprove computes
 * usage/pricing, Letterstory's own separate cron does the actual charging)
 * against a real Postgres schema, driving the REAL rollup_agentic_reads_daily()
 * SQL function rather than seeding agentic_read_rollups by hand. Flagged by
 * the 2026-09-28 e2e audit: staff-tools.e2e.test.ts already proves the
 * capability gate (billing:read, not staff:read) but seeds the rollup table
 * directly, so nothing had ever driven the rollup function itself or proven
 * month-over-month recurrence — the part of "recurring payments" this tool
 * actually owns before the boundary into Letterstory's cron.
 */

const VENDOR_ID = randomUUID();
const VENDOR_SLUG = "billing-e2e-acme";
const ORG_ID = randomUUID();

const OTHER_VENDOR_ID = randomUUID();
const OTHER_VENDOR_SLUG = "billing-e2e-globex";
const OTHER_ORG_ID = randomUUID();

let pg: PGlite;

function monthStart(monthsAgo: number): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
}

function isoDaysInto(month: Date, day: number): string {
	return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day)).toISOString();
}

const THIS_MONTH = monthStart(0);
const LAST_MONTH = monthStart(1);
const THIS_MONTH_YYYY_MM = THIS_MONTH.toISOString().slice(0, 10);
const LAST_MONTH_YYYY_MM = LAST_MONTH.toISOString().slice(0, 10);

async function seedReads(vendorSlug: string, month: Date, count: number) {
	if (count === 0) return;
	const rows = Array.from({ length: count }, (_, i) => `('${vendorSlug}', 'reader', 'test-agent', '${isoDaysInto(month, 2 + (i % 20))}', true)`);
	await pg.query(
		`insert into agentic_read_events (vendor_slug, subject, agent_name, receipt_ts, verified) values ${rows.join(", ")}`,
	);
}

beforeAll(async () => {
	pg = await bootstrapPglite();
	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key, letterstory_org_id) values ($1, $2, 'Billing E2E Acme', 'billing-e2e-acme.example', 'test', $3, $4)",
		[VENDOR_ID, VENDOR_SLUG, `lp_live_${VENDOR_SLUG}`, ORG_ID],
	);
	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key, letterstory_org_id) values ($1, $2, 'Billing E2E Globex', 'billing-e2e-globex.example', 'test', $3, $4)",
		[OTHER_VENDOR_ID, OTHER_VENDOR_SLUG, `lp_live_${OTHER_VENDOR_SLUG}`, OTHER_ORG_ID],
	);
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase(pg) as never);
	await pg.query("delete from agentic_read_events");
	await pg.query("delete from agentic_read_rollups");
});

function serviceCaller(): OAuthPrincipal {
	return {
		tokenId: "letterstory-service",
		vendorId: null,
		userId: "letterstory-service",
		capabilities: ["billing:read"],
		orgId: undefined,
	};
}

describe("agentic_read_billing, driven through the real rollup_agentic_reads_daily() SQL function", () => {
	it("prices last month's reads correctly and keeps this month's count separate (recurrence, not accumulation)", async () => {
		// 600 in the closed prior month (25 free + 475 at tier2 + 100 at tier3),
		// 10 in the still-accumulating current month — must never leak into the
		// prior month's bill.
		await seedReads(VENDOR_SLUG, LAST_MONTH, 600);
		await seedReads(VENDOR_SLUG, THIS_MONTH, 10);
		await pg.query("select rollup_agentic_reads_daily()");

		const { dispatchTool } = await import("./registry");

		const priorMonth = await dispatchTool("agentic_read_billing", { billing_month: LAST_MONTH_YYYY_MM }, serviceCaller());
		expect(priorMonth.kind).toBe("result");
		if (priorMonth.kind !== "result" || !priorMonth.result.ok) throw new Error("expected ok result");
		const priorBody = priorMonth.result.body as {
			billing_month: string;
			vendors: { vendor: string; org_id: string | null; read_count: number; tier2_reads: number; tier3_reads: number; amount_cents: number }[];
		};
		expect(priorBody.billing_month).toBe(LAST_MONTH_YYYY_MM);
		const acmePrior = priorBody.vendors.find((v) => v.vendor === VENDOR_SLUG);
		expect(acmePrior).toMatchObject({ org_id: ORG_ID, read_count: 600, tier2_reads: 475, tier3_reads: 100, amount_cents: 475 * 20 + 100 * 8 });

		const thisMonth = await dispatchTool("agentic_read_billing", { billing_month: THIS_MONTH_YYYY_MM }, serviceCaller());
		if (thisMonth.kind !== "result" || !thisMonth.result.ok) throw new Error("expected ok result");
		const thisBody = thisMonth.result.body as { vendors: { vendor: string; read_count: number; amount_cents: number }[] };
		const acmeThisMonth = thisBody.vendors.find((v) => v.vendor === VENDOR_SLUG);
		// 10 reads is under the 25 free reads — a real month with real usage
		// that still owes nothing, not "no data".
		expect(acmeThisMonth).toMatchObject({ read_count: 10, amount_cents: 0 });
	});

	it("defaults to the previous calendar month when billing_month is omitted, matching an unattended monthly invoicing call", async () => {
		await seedReads(VENDOR_SLUG, LAST_MONTH, 100);
		await pg.query("select rollup_agentic_reads_daily()");

		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("agentic_read_billing", {}, serviceCaller());
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected ok result");
		const body = outcome.result.body as { billing_month: string; vendors: { vendor: string }[] };
		expect(body.billing_month).toBe(LAST_MONTH_YYYY_MM);
		expect(body.vendors.map((v) => v.vendor)).toContain(VENDOR_SLUG);
	});

	it("re-running the daily rollup recomputes rather than doubling the count — idempotent under a retried or repeated cron tick", async () => {
		await seedReads(VENDOR_SLUG, LAST_MONTH, 50);
		await pg.query("select rollup_agentic_reads_daily()");
		await pg.query("select rollup_agentic_reads_daily()");
		await pg.query("select rollup_agentic_reads_daily()");

		const { rows } = await pg.query<{ read_count: number }>(
			"select read_count from agentic_read_rollups where vendor_slug = $1 and billing_month = $2",
			[VENDOR_SLUG, LAST_MONTH_YYYY_MM],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].read_count).toBe(50);
	});

	it("a late-arriving read before the month closes is picked up on the next rollup tick, not frozen at first run", async () => {
		await seedReads(VENDOR_SLUG, LAST_MONTH, 30);
		await pg.query("select rollup_agentic_reads_daily()");
		await seedReads(VENDOR_SLUG, LAST_MONTH, 5);
		await pg.query("select rollup_agentic_reads_daily()");

		const { rows } = await pg.query<{ read_count: number }>(
			"select read_count from agentic_read_rollups where vendor_slug = $1 and billing_month = $2",
			[VENDOR_SLUG, LAST_MONTH_YYYY_MM],
		);
		expect(rows[0].read_count).toBe(35);
	});

	it("a billing month with no rollup at all reports an empty vendor list, not an error and not stale data", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("agentic_read_billing", { billing_month: "2019-01-01" }, serviceCaller());
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { billing_month: "2019-01-01", vendors: [] } } });
	});

	it("reports multiple vendors for the same month, sorted by amount owed, descending", async () => {
		await seedReads(VENDOR_SLUG, LAST_MONTH, 600);
		await seedReads(OTHER_VENDOR_SLUG, LAST_MONTH, 100);
		await pg.query("select rollup_agentic_reads_daily()");

		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("agentic_read_billing", { billing_month: LAST_MONTH_YYYY_MM }, serviceCaller());
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected ok result");
		const body = outcome.result.body as { vendors: { vendor: string; org_id: string | null }[] };
		expect(body.vendors.map((v) => v.vendor)).toEqual([VENDOR_SLUG, OTHER_VENDOR_SLUG]);
		expect(body.vendors.find((v) => v.vendor === OTHER_VENDOR_SLUG)?.org_id).toBe(OTHER_ORG_ID);
	});
});
