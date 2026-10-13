import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";
import { MIN_COHORT, growthFor, retentionFor, retentionOf } from "./growth";

/**
 * Growth and retention against the real schema: the two SQL reads in
 * 20261013193303_growth_retention_reads.sql, called through supabase-js rpc.
 */

let pg: PGlite;
vi.mock("@/lib/db/client", () => ({ dbClient: () => pgliteSupabase(pg) }));

const DAY = 24 * 60 * 60 * 1000;

function monthsAgo(n: number): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 10, 12));
}

async function snapshot(slug: string, at: Date, companies: number) {
	await pg.query(
		`insert into published_aggregates (vendor_slug, hour_bucket, published_at, attestation) values ($1, $2, $3, $4)`,
		[slug, Math.floor(at.getTime() / 3_600_000), at.toISOString(), JSON.stringify({ kind: "aggregate", companies_observed: companies })],
	);
}

async function rollup(slug: string, domain: string, daysAgo: number) {
	await pg.query(`insert into hot_rollups (vendor_slug, domain, window_start, sessions) values ($1, $2, $3, 1)`, [
		slug,
		domain,
		new Date(Date.now() - daysAgo * DAY).toISOString(),
	]);
}

beforeAll(async () => {
	pg = await bootstrapPglite();
	// Three months of history; the month's highest snapshot counts.
	await snapshot("grow", monthsAgo(2), 40);
	await snapshot("grow", new Date(monthsAgo(1).getTime()), 55);
	await snapshot("grow", new Date(monthsAgo(1).getTime() + DAY), 61);
	await snapshot("grow", monthsAgo(0), 70);
	// Older than six months: out of range.
	await snapshot("grow", monthsAgo(8), 5);
	await snapshot("lonely", monthsAgo(0), 3);

	// Retention cohort: 12 companies 60-90 days ago, 9 of them seen again lately,
	// plus free mail that must not count.
	for (let i = 0; i < 12; i++) await rollup("keep", `co${i}-test.com`, 75);
	await rollup("keep", "gmail.com", 75);
	for (let i = 0; i < 9; i++) await rollup("keep", `co${i}-test.com`, 5);
	await rollup("keep", "gmail.com", 5);
	// Too small a cohort.
	for (let i = 0; i < 4; i++) await rollup("tiny", `t${i}-test.com`, 75);
});

afterAll(async () => {
	await pg.close();
});

describe("growth", () => {
	it("reports the highest companies_observed per month, oldest first, within six months", async () => {
		const points = await growthFor("grow");
		expect(points).not.toBeNull();
		expect(points!.map((p) => p.companies_observed)).toEqual([40, 61, 70]);
		expect(points!.every((p) => /^\d{4}-\d{2}$/.test(p.month))).toBe(true);
	});

	it("is absent with a single month of history", async () => {
		expect(await growthFor("lonely")).toBeNull();
	});
});

describe("retention", () => {
	it("counts how many of the companies active 60 days ago are still signing in, company domains only", async () => {
		expect(await retentionFor("keep", "keep.example")).toEqual({ cohort: 12, retained: 9, window: "60d" });
	});

	it(`is absent when the cohort is under ${MIN_COHORT}`, async () => {
		expect(await retentionFor("tiny", "tiny.example")).toBeNull();
		expect(retentionOf(["a.com"], ["a.com"])).toBeNull();
	});
});
