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
import { readAllRows } from "@/lib/db/read-all";

export interface CustomerSnapshot {
	observed_through: string;
	published_at: string;
	sessions_30d: number;
	seats_active: number;
	/**
	 * Whether this window contains any observation at all — the distinction a
	 * bare `sessions_30d: 0` cannot make.
	 *
	 * Four different situations produce a zero count: no datastore configured,
	 * a failed query, a customer with no rolled-up rows, and rows that
	 * genuinely sum to zero. Only the last is a measurement; the rest are the
	 * absence of one. `proofs.ts` gates the published tier on this, so
	 * collapsing them would let an unmeasured customer publish an earned-
	 * looking claim.
	 *
	 * Keyed off row existence rather than the session sum: a row with zero
	 * sessions but a signup or a login is still an observation of the account.
	 *
	 * NOT published. It is evidence *about* the claim, not part of it, and it
	 * never enters the signed body.
	 */
	observed: boolean;
	/**
	 * Whether the telemetry read actually succeeded.
	 *
	 * `observed: false` still conflates two things one level up: "the query ran
	 * and found nothing" and "the query never ran". The live path can treat
	 * those alike, because it recomputes next hour and self-heals. The freeze
	 * path cannot — it writes an immutable row, so persisting a tier-0 claim
	 * derived from a failed query records a permanent downgrade for a customer
	 * that may have been fine.
	 *
	 * Also NOT published, for the same reason as `observed`.
	 */
	readOk: boolean;
}

const WINDOW_DAYS = 30;

export async function currentSnapshot(vendorSlug: string, domain: string): Promise<CustomerSnapshot> {
	const now = new Date();
	// Fails toward the weaker claim: every path that isn't a successful read of
	// real rows leaves `observed` false, so an outage degrades a proof to
	// vendor-asserted rather than publishing a tier nothing backs.
	const fallback: CustomerSnapshot = {
		observed_through: now.toISOString(),
		published_at: now.toISOString(),
		sessions_30d: 0,
		seats_active: 0,
		observed: false,
		readOk: false,
	};

	const db = dbClient();
	if (!db) return fallback;

	const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
	// Paged: this sum IS `sessions_30d`, the headline number in the signed
	// customer body. An unbounded select returns the first 1000 rows with no
	// error and no marker (see read-all.ts), so a busy customer would publish a
	// signed, hash-chained understatement of its own usage — a truncated read
	// feeding a signed number, which is the one failure this product cannot
	// have.
	//
	// A 30-day window holds at most 720 hourly rows for one (vendor, domain)
	// today, which is under the cap. That is a property of the rollup being
	// hourly, not a guarantee: it is one backfill or one finer bucket away from
	// being false, and the failure when it becomes false is silent and
	// permanent. Ordered on window_start, which is unique once vendor_slug and
	// domain are both fixed (see the hot_rollups unique constraint), so paging
	// can neither repeat nor skip a row.
	let rows: { sessions: number }[];
	try {
		rows = await readAllRows(`rollups for ${vendorSlug}/${domain}`, (from, to) =>
			db
				.from("hot_rollups")
				.select("sessions")
				.eq("vendor_slug", vendorSlug)
				.eq("domain", domain)
				.gte("window_start", since)
				.order("window_start", { ascending: true })
				.range(from, to),
		);
	} catch (e) {
		// Still the fallback, which leaves readOk false. The freeze path writes
		// an immutable row, so a failed read must never be recorded as a
		// measured zero.
		console.error("[letterprove:snapshots] query failed", e instanceof Error ? e.message : String(e));
		return fallback;
	}

	const sessions_30d = rows.reduce((sum: number, row: { sessions: number }) => sum + row.sessions, 0);
	return { ...fallback, sessions_30d, observed: rows.length > 0, readOk: true };
}
