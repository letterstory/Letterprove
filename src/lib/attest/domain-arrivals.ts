/**
 * When each of a vendor's customer domains was first observed.
 *
 * This exists because of the attack the volume checks cannot see. The headline
 * published claim is `companies_observed` — a count of DISTINCT DOMAINS — and
 * inflating it costs one event per invented domain, not thousands. Measured on
 * real production data (lettertrace, 2026-08): the median domain has 3 events
 * and two thirds have 3 or fewer, so a fabricated customer sending one or two
 * events is statistically indistinguishable from a third of the real ones.
 * Timing-shape analysis of event VOLUME is simply looking at the wrong axis.
 *
 * What does separate them is arrival: real companies trickle in, because a
 * domain only appears when somebody from it actually shows up. The same
 * production window has 51 domains spread over 172 hours — 6 / 11 / 13 / 11 /
 * 6 / 4 per day, and only 6% inside the first hour. Fabricated breadth arrives
 * in a clump, because it is one loop.
 *
 * Sends timestamps, never domain names: the scorer needs the shape of the
 * arrivals, and shipping the customer list off to a second service to learn
 * that would be an unforced disclosure. No new collection either — `domain`
 * and the rollup window are already stored, so this needs no schema change and
 * no privacy-policy change.
 */

import { dbClient } from "@/lib/db/client";

export interface DomainArrivals {
	/**
	 * Earliest observation for this vendor at all, across every domain and all
	 * of history. The scorer needs it to tell a fresh install from a clump: a
	 * vendor who installs the script with an existing user base legitimately
	 * discovers many domains at once, and that must not read as fabrication.
	 */
	vendor_first_seen: string | null;
	/**
	 * One ISO timestamp per distinct domain — when that domain was first seen,
	 * ascending. No domain names, by design.
	 */
	first_seen: string[];
}

/**
 * Deliberately NOT windowed to the publishing period. "First seen" has to mean
 * first seen ever, or a domain that has been around for months looks brand new
 * every time the window slides past its early events — which would make a
 * long-standing customer indistinguishable from one invented this morning.
 */
export async function domainArrivals(vendorSlug: string): Promise<DomainArrivals> {
	const empty: DomainArrivals = { vendor_first_seen: null, first_seen: [] };

	const db = dbClient();
	if (!db) return empty;

	// Ascending, so the first row seen for a domain is its earliest and the
	// very first row is the vendor's own start. One pass, no per-domain query.
	const { data, error } = await db
		.from("hot_rollups")
		.select("domain, window_start")
		.eq("vendor_slug", vendorSlug)
		.order("window_start", { ascending: true });

	if (error) {
		// Same posture as fraudFeatures: fail to an unremarkable empty rather
		// than throwing. An absent signal is scored as "nothing to say here",
		// never as evidence of innocence.
		console.error("[letterprove:domain-arrivals] query failed", error.message);
		return empty;
	}

	const rows = (data ?? []) as { domain: string; window_start: string }[];
	if (rows.length === 0) return empty;

	const firstByDomain = new Map<string, string>();
	for (const row of rows) {
		if (!firstByDomain.has(row.domain)) firstByDomain.set(row.domain, row.window_start);
	}

	return {
		vendor_first_seen: rows[0].window_start,
		first_seen: [...firstByDomain.values()].sort(),
	};
}
