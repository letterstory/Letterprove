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
}

const WINDOW_DAYS = 30;

export async function fraudFeatures(
	vendorSlug: string,
	customerSlug: string,
	domain: string
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

	const { data, error } = await db
		.from("hot_rollups")
		.select("sessions, signups, logins")
		.eq("vendor_slug", vendorSlug)
		.eq("domain", domain)
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

	return { ...empty, events: { sessions, signups, logins }, hourly_buckets };
}
