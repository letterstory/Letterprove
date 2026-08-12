/**
 * The hourly rollup — README's Publication shape `method` link points here.
 *
 * Turns raw `hot_events` into `hot_rollups`, the table publishing will
 * eventually read instead of fixtures.ts. The aggregation itself lives in
 * the `rollup_hot_events_hourly` SQL function (see the migration) so it runs
 * as a single set-based upsert rather than pulling rows into Node; this
 * module is the thin, testable seam the cron route calls.
 */

import { dbClient } from "@/lib/db/client";

export interface RollupResult {
	ok: boolean;
	/** Present when ok is false. */
	detail?: string;
}

export async function rollupHotEvents(): Promise<RollupResult> {
	const db = dbClient();
	if (!db) return { ok: false, detail: "no datastore configured" };

	const { error } = await db.rpc("rollup_hot_events_hourly");
	if (error) return { ok: false, detail: error.message };
	return { ok: true };
}
