/**
 * Where a vendor's observed events arrived from, as counts per region.
 *
 * REPORTED, NOT SCORED — and that is a decision, not an omission.
 *
 * Geo was meant to be the cheap substitute for ASN: 45 invented customers
 * curled from one machine share one region, where 45 real companies do not.
 * The first real production data says the honest half of that is true —
 * lettertrace's traffic spans 5 countries and 6 distinct regions. But the
 * inverse does not follow, and that is what kills the automatic rule: a
 * legitimate UK-only SaaS has 100% of its traffic in one region too.
 * Single-region concentration is evidence of a REGIONAL BUSINESS at least as
 * often as it is evidence of fraud, and this file cannot tell them apart.
 *
 * A false negative here costs one inflated claim. A false positive refuses a
 * signature to an honest vendor who has no way to argue with it — and would
 * do so systematically to every non-US company. So the distribution ships in
 * the feature stream where a human and later a fraud model can weigh it, and
 * nothing in the countersigner rejects on it alone.
 *
 * What would make it scoreable: combining it with breadth. Forty domains that
 * arrive in a clump AND share one region is a much stronger signal than
 * either alone — but the arrival check already refuses that clump, so the
 * combination has nothing left to catch today. When arrivals are dripped
 * slowly enough to pass, geo becomes the second axis worth scoring, and the
 * threshold should be calibrated against real multi-vendor data rather than
 * the single vendor we currently have.
 */

import { dbClient } from "@/lib/db/client";

export interface GeoDistribution {
	/**
	 * Counts keyed by "COUNTRY" or "COUNTRY-REGION", descending. Vercel reports
	 * a country without a region often enough that they cannot be merged — see
	 * the AU rows in production, which have no region at all.
	 */
	regions: Record<string, number>;
	/** Events in the window that carry no location, for honesty about coverage. */
	unknown: number;
	distinctRegions: number;
}

const WINDOW_DAYS = 30;

/** Empty is a real answer here: every row predating geo capture has no location. */
const EMPTY: GeoDistribution = { regions: {}, unknown: 0, distinctRegions: 0 };

export async function geoDistribution(vendorSlug: string): Promise<GeoDistribution> {
	const db = dbClient();
	if (!db) return EMPTY;

	const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const { data, error } = await db
		.from("hot_events")
		.select("country, region")
		.eq("vendor_slug", vendorSlug)
		.gte("receipt_ts", since);

	if (error) {
		// Same posture as the other extractors: fail to an unremarkable empty
		// rather than throwing. An absent signal is "nothing to say", never
		// evidence of innocence.
		console.error("[letterprove:geo] query failed", error.message);
		return EMPTY;
	}

	const rows = (data ?? []) as { country: string | null; region: string | null }[];
	const counts = new Map<string, number>();
	let unknown = 0;

	for (const row of rows) {
		if (!row.country) {
			unknown++;
			continue;
		}
		const key = row.region ? `${row.country}-${row.region}` : row.country;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	// Descending, then by key, so the same data always serialises identically —
	// this ends up in a payload that gets compared across runs.
	const regions: Record<string, number> = {};
	for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
		regions[key] = n;
	}

	return { regions, unknown, distinctRegions: counts.size };
}
