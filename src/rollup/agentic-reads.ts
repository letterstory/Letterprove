/**
 * Agentic-read billing rollup — turns raw `agentic_read_events` into the
 * per-vendor, per-month `agentic_read_rollups` count that
 * src/lib/billing/agentic-reads.ts prices. The aggregation lives in the
 * `rollup_agentic_reads_hourly` SQL function (see the migration) so it runs
 * as a single set-based upsert; this module is the thin, testable seam the
 * cron route calls, the same shape as rollup/sessions.ts and rollup/prune.ts.
 */

import { dbClient } from "@/lib/db/client";

export interface RollupResult {
	ok: boolean;
	/** Present when ok is false. */
	detail?: string;
}

export async function rollupAgenticReads(): Promise<RollupResult> {
	const db = dbClient();
	if (!db) return { ok: false, detail: "no datastore configured" };

	const { error } = await db.rpc("rollup_agentic_reads_hourly");
	if (error) return { ok: false, detail: error.message };
	return { ok: true };
}

export interface PruneResult {
	ok: boolean;
	/** Rows deleted. Present when ok is true. */
	deleted?: number;
	/** Present when ok is false. */
	detail?: string;
}

export async function pruneAgenticReadEvents(): Promise<PruneResult> {
	const db = dbClient();
	if (!db) return { ok: false, detail: "no datastore configured" };

	const { data, error } = await db.rpc("prune_agentic_read_events");
	if (error) return { ok: false, detail: error.message };
	return { ok: true, deleted: Number(data ?? 0) };
}
