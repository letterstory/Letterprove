/**
 * Config-fetch pings — one upsert per vendor whenever GET /v1/config resolves
 * a known key. See supabase/migrations/20260821040000_config_pings.sql for
 * why this exists and src/lib/vendors/status.ts for how the dashboard uses
 * it.
 *
 * The timestamp comes from the database, not from here — see
 * supabase/migrations/20260821050000_config_ping_db_clock.sql. Note that
 * `last_seen` is coarser than it looks: /v1/config is CDN-cached (300s, plus
 * an hour of stale-while-revalidate — see configJson in src/lib/http.ts), so
 * a cache hit never reaches this code and a busy vendor can ping far less
 * often than they actually load. Fine for "has this ever booted", which is
 * all status.ts asks; not a basis for "is this still installed".
 */

import { dbClient } from "@/lib/db/client";

export async function recordConfigPing(vendorSlug: string): Promise<void> {
	const db = dbClient();
	if (!db) return; // Never let telemetry break config delivery — no config client, no write, no throw.

	try {
		// supabase-js resolves query errors on the result rather than throwing —
		// check `error` explicitly, or a bad upsert fails silently forever.
		const { error } = await db.rpc("record_config_ping", { slug: vendorSlug });
		if (error) console.error("[letterprove:config] ping upsert failed", error.message);
	} catch (error) {
		console.error("[letterprove:config] ping upsert threw", error);
	}
}
