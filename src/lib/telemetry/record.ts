/**
 * Hot-tier observation storage — README § Publication / Freshness: "raw
 * events, minutes old, unsigned. What the team sees internally." The hourly
 * rollup (account × feature) reads this table next; fixtures.ts is what it
 * eventually replaces (see that file's header comment).
 *
 * Bound to facts the client did not supply, per the Event schema decision:
 * `receipt_ts` (server time, via the column default), not the client's
 * untrusted `ts`; and the request origin. ASN is deliberately NOT captured
 * here — it needs a GeoIP/ASN lookup this deploy doesn't have wired, and
 * faking it would be worse than omitting it. Fraud scoring in Letterstory
 * can't key off ASN concentration until that lands for real.
 */

import { dbClient } from "@/lib/db/client";
import type { EventType } from "./events";

export async function recordObservation(params: {
	vendor: string;
	domain: string;
	ev: EventType;
	cfg: number;
	origin: string;
}): Promise<void> {
	const db = dbClient();
	if (!db) return; // Never let telemetry break collection — no config, no write, no throw.

	try {
		// supabase-js resolves query errors on the result rather than throwing —
		// check `error` explicitly, or a bad insert fails silently forever.
		const { error } = await db.from("hot_events").insert({
			vendor_slug: params.vendor,
			domain: params.domain,
			ev: params.ev,
			cfg: params.cfg,
			origin: params.origin,
		});
		if (error) console.error("[letterprove:observe] insert failed", error.message);
	} catch (error) {
		console.error("[letterprove:observe] insert threw", error);
	}
}
