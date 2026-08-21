/**
 * Config-fetch pings — one upsert per vendor whenever GET /v1/config resolves
 * a known key. See supabase/migrations/20260820220000_config_pings.sql for
 * why this exists and src/lib/vendors/status.ts for how the dashboard uses
 * it.
 */

import { dbClient } from "@/lib/db/client";

export async function recordConfigPing(vendorSlug: string): Promise<void> {
	const db = dbClient();
	if (!db) return; // Never let telemetry break config delivery — no config client, no write, no throw.

	try {
		// supabase-js resolves query errors on the result rather than throwing —
		// check `error` explicitly, or a bad upsert fails silently forever.
		const { error } = await db
			.from("config_pings")
			.upsert({ vendor_slug: vendorSlug, last_seen: new Date().toISOString() }, { onConflict: "vendor_slug" });
		if (error) console.error("[letterprove:config] ping upsert failed", error.message);
	} catch (error) {
		console.error("[letterprove:config] ping upsert threw", error);
	}
}
