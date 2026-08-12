/**
 * Real snapshot data for publishing — what `bodiesFor` (src/lib/attest/proofs.ts)
 * reads instead of a fixture's static snapshot list. Sums `hot_rollups.sessions`
 * over the trailing 30 days for a given (vendor, domain).
 *
 * `seats_active` is not computed here and is always 0: phase-1 events carry no
 * per-user dimension (see rollup_hot_events_hourly's migration comment), so
 * there is nothing honest to sum. Signed as a literal 0 rather than omitted —
 * the field is required and covered by the attestation signature — 0 reads as
 * "not yet measured," not "zero active seats observed." (Decision 2026-08-12.)
 */

import { dbClient } from "@/lib/db/client";

export interface CustomerSnapshot {
	observed_through: string;
	published_at: string;
	sessions_30d: number;
	seats_active: number;
}

const WINDOW_DAYS = 30;

export async function currentSnapshot(vendorSlug: string, domain: string): Promise<CustomerSnapshot> {
	const now = new Date();
	const fallback: CustomerSnapshot = {
		observed_through: now.toISOString(),
		published_at: now.toISOString(),
		sessions_30d: 0,
		seats_active: 0,
	};

	const db = dbClient();
	if (!db) return fallback;

	const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const { data, error } = await db
		.from("hot_rollups")
		.select("sessions")
		.eq("vendor_slug", vendorSlug)
		.eq("domain", domain)
		.gte("window_start", since);

	if (error) {
		console.error("[letterprove:snapshots] query failed", error.message);
		return fallback;
	}

	const sessions_30d = (data ?? []).reduce((sum: number, row: { sessions: number }) => sum + row.sessions, 0);
	return { ...fallback, sessions_30d };
}
