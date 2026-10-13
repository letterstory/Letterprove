/**
 * Growth and retention: two optional proof sections, both counts from
 * Letterprove's own observations. Neither names a customer and neither moves
 * the tier. A vendor can hide either (src/lib/attest/display.ts).
 *
 *   growth     companies observed per calendar month, from the signed
 *              aggregate history: the highest companies_observed any frozen
 *              snapshot carried that month.
 *   retention  of the company domains observed in the 30 days ending 60 days
 *              ago, how many were also observed in the last 30 days. Omitted
 *              when that cohort is under MIN_COHORT: a share of a handful of
 *              companies says nothing.
 *
 * Every read fails toward saying less: a failed read omits the section.
 */

import { dbClient } from "@/lib/db/client";
import { partitionDomains } from "@/lib/identity/domains";

export const GROWTH_MONTHS = 6;
export const MIN_COHORT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GrowthPoint {
	month: string;
	companies_observed: number;
}

export interface Retention {
	/** Company domains observed in the 30 days ending 60 days ago. */
	cohort: number;
	/** Of those, how many were also observed in the last 30 days. */
	retained: number;
	window: "60d";
}

export async function growthFor(vendorSlug: string): Promise<GrowthPoint[] | null> {
	const db = dbClient();
	if (!db) return null;
	try {
		const { data, error } = await db.rpc("vendor_monthly_companies", { p_vendor_slug: vendorSlug, p_months: GROWTH_MONTHS });
		if (error || !Array.isArray(data)) return null;
		const points = (data as { month?: unknown; companies_observed?: unknown }[])
			.filter((p) => typeof p.month === "string" && /^\d{4}-\d{2}$/.test(p.month) && Number.isFinite(Number(p.companies_observed)))
			.map((p) => ({ month: p.month as string, companies_observed: Math.max(0, Math.floor(Number(p.companies_observed))) }));
		// One month is not a trend.
		return points.length >= 2 ? points : null;
	} catch {
		return null;
	}
}

async function windowDomains(vendorSlug: string, from: Date, to: Date): Promise<string[] | null> {
	const db = dbClient();
	if (!db) return null;
	try {
		const { data, error } = await db.rpc("vendor_window_domains", {
			p_vendor_slug: vendorSlug,
			p_from: from.toISOString(),
			p_to: to.toISOString(),
		});
		if (error || !Array.isArray(data)) return null;
		return (data as unknown[]).filter((d): d is string => typeof d === "string");
	} catch {
		return null;
	}
}

/** Pure: the retention figure from two windows of attributable domains. */
export function retentionOf(cohortDomains: readonly string[], recentDomains: readonly string[]): Retention | null {
	const cohort = new Set(cohortDomains);
	if (cohort.size < MIN_COHORT) return null;
	const recent = new Set(recentDomains);
	let retained = 0;
	for (const d of cohort) if (recent.has(d)) retained++;
	return { cohort: cohort.size, retained, window: "60d" };
}

export async function retentionFor(vendorSlug: string, vendorDomain: string, now = Date.now()): Promise<Retention | null> {
	const [then, recent] = await Promise.all([
		windowDomains(vendorSlug, new Date(now - 90 * DAY_MS), new Date(now - 60 * DAY_MS)),
		windowDomains(vendorSlug, new Date(now - 30 * DAY_MS), new Date(now)),
	]);
	if (!then || !recent) return null;
	return retentionOf(partitionDomains(then, vendorDomain).attributable, partitionDomains(recent, vendorDomain).attributable);
}
