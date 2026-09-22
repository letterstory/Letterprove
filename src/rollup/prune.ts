/**
 * Raw-event retention: deletes hot_events rows older than 35 days.
 *
 * The window and the reasoning live in the `prune_hot_events` SQL function
 * (migration 20260922230000); this is the thin seam the hourly cron calls,
 * the same shape as rollupHotEvents() beside it.
 */

import { dbClient } from "@/lib/db/client";

export interface PruneResult {
  ok: boolean;
  /** Rows deleted. Present when ok is true. */
  deleted?: number;
  /** Present when ok is false. */
  detail?: string;
}

export async function pruneHotEvents(): Promise<PruneResult> {
  const db = dbClient();
  if (!db) return { ok: false, detail: "no datastore configured" };

  const { data, error } = await db.rpc("prune_hot_events");
  if (error) return { ok: false, detail: error.message };
  return { ok: true, deleted: Number(data ?? 0) };
}
