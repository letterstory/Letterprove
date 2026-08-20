/**
 * Synthetic canary for the collector's write path — the exact thing
 * `recordObservation()` swallows errors for (see record.ts: "telemetry must
 * never break the collector"). Nothing else in this codebase surfaces an
 * insert failure, so an outage there is invisible unless something goes
 * looking. This is that something, run on a schedule instead of by hand.
 *
 * Writes and immediately deletes a single marked row rather than reading real
 * vendor traffic, so it: (a) exercises the actual insert path end-to-end
 * without depending on any vendor having sent a real event recently — a
 * vendor with genuinely zero visitors this hour must never page anyone — and
 * (b) never pollutes `hot_events` or the hourly rollup with fake data.
 */

import { dbClient } from "@/lib/db/client";

/** Never a real vendor slug (vendor slugs come from the `vendors` table, not user input) — filterable out of any real query by construction. */
export const CANARY_VENDOR_SLUG = "__collector_health_check__";

export interface CollectorHealth {
	ok: boolean;
	detail: string;
}

export async function checkCollectorHealth(): Promise<CollectorHealth> {
	const db = dbClient();
	if (!db) {
		return { ok: false, detail: "no datastore configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing)" };
	}

	const { data, error: insertError } = await db
		.from("hot_events")
		.insert({
			vendor_slug: CANARY_VENDOR_SLUG,
			domain: "healthcheck.internal",
			ev: "session",
			cfg: 0,
			origin: "healthcheck.internal",
		})
		.select("id")
		.single();

	if (insertError || !data) {
		return { ok: false, detail: `insert failed: ${insertError?.message ?? "no row returned"}` };
	}

	const { error: deleteError } = await db.from("hot_events").delete().eq("id", (data as { id: number }).id);
	if (deleteError) {
		// The write path works — that's what this checks — cleanup failing is a
		// logged footgun (a stray canary row), not a collector outage. Don't
		// fail the health check over it.
		console.error("[letterprove:collector-health] canary row cleanup failed", deleteError.message);
	}

	return { ok: true, detail: "insert + cleanup succeeded" };
}
