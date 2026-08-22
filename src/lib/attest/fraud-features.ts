/**
 * Fraud-feature extraction — what Letterprove sends to Letterstory's
 * countersign RPC alongside the unsigned body, so the countersigner can score
 * the same window before minting a signature. README "Processing —
 * Letterprove side" step 3. Shaped to match lb's
 * `src/lib/letterprove/fraud-check.ts` field-for-field — the two were built
 * together against the same contract.
 *
 * Scoped to what `hot_rollups` actually holds: event-volume counts per hour.
 * `asn_distribution`/`distinct_hash_counts` are always null — ASN is never
 * populated (see telemetry/record.ts) and there is no per-user-hash column
 * at all yet. Faking either would be worse than the honest null the RPC's
 * schema already expects.
 *
 * Same trailing window as `currentSnapshot` (src/rollup/snapshots.ts): the
 * fraud check has to score the same population the published sessions_30d
 * figure is drawn from, not a different slice of history.
 */

import { dbClient } from "@/lib/db/client";
import { domainArrivals, type DomainArrivals } from "./domain-arrivals";

export interface FraudFeatures {
	schema_version: 1;
	vendor: string;
	customer: string;
	window: { start: string; end: string };
	events: { sessions: number; signups: number; logins: number };
	/** One entry per hourly rollup row in the window, chronological order. */
	hourly_buckets: number[];
	asn_distribution: null;
	distinct_hash_counts: null;
	/**
	 * When each distinct domain was first observed — see domain-arrivals.ts for
	 * why the count of domains, not the volume per domain, is the number worth
	 * defending.
	 *
	 * Added WITHOUT bumping schema_version, deliberately. The countersigner
	 * rejects any version it does not recognise, so bumping would mean every
	 * signature failing for however long it took the two deploys to line up.
	 * An additive optional field is not a breaking change: an older scorer
	 * ignores it, a newer one uses it, and neither ordering breaks signing.
	 */
	domain_arrivals?: DomainArrivals;
}

const WINDOW_DAYS = 30;

/**
 * @param domain one customer's join key, or `null` to score the vendor as a
 *   whole. The vendor-wide form backs the aggregate attestation, which makes
 *   a claim about every observed company at once and so has no single domain
 *   to filter on. Burst detection is arguably sharper there: traffic
 *   concentrated in one hour across *all* of a vendor's domains is a better
 *   spoofing tell than the same shape for one customer.
 */
export async function fraudFeatures(
	vendorSlug: string,
	customerSlug: string,
	domain: string | null
): Promise<FraudFeatures> {
	const now = new Date();
	const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

	// Fails toward an unremarkable-looking, all-zero window rather than
	// throwing: the same outage already drops the published body to tier 0 /
	// unverified via currentSnapshot's own fallback, so there is nothing here
	// for a zero window to falsely vouch for.
	const empty: FraudFeatures = {
		schema_version: 1,
		vendor: vendorSlug,
		customer: customerSlug,
		window: { start: since.toISOString(), end: now.toISOString() },
		events: { sessions: 0, signups: 0, logins: 0 },
		hourly_buckets: [],
		asn_distribution: null,
		distinct_hash_counts: null,
	};

	const db = dbClient();
	if (!db) return empty;

	const arrivals = await domainArrivals(vendorSlug);

	let query = db
		.from("hot_rollups")
		.select("sessions, signups, logins")
		.eq("vendor_slug", vendorSlug);
	if (domain !== null) query = query.eq("domain", domain);
	const { data, error } = await query
		.gte("window_start", since.toISOString())
		.order("window_start", { ascending: true });

	if (error) {
		console.error("[letterprove:fraud-features] query failed", error.message);
		return empty;
	}

	const rows = (data ?? []) as { sessions: number; signups: number; logins: number }[];
	const sessions = rows.reduce((sum, r) => sum + r.sessions, 0);
	const signups = rows.reduce((sum, r) => sum + r.signups, 0);
	const logins = rows.reduce((sum, r) => sum + r.logins, 0);
	// Bucket identity doesn't matter to the burst check on the other end, only
	// relative share, so summing all three event kinds per row is enough.
	const hourly_buckets = rows.map((r) => r.sessions + r.signups + r.logins);

	return { ...empty, events: { sessions, signups, logins }, hourly_buckets, domain_arrivals: arrivals };
}
