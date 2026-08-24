/**
 * Hot-tier observation storage — README § Publication / Freshness: "raw
 * events, minutes old, unsigned. What the team sees internally." The hourly
 * rollup (account × feature) reads this table next; fixtures.ts is what it
 * eventually replaces (see that file's header comment).
 *
 * Bound to facts the client did not supply, per the Event schema decision:
 * `receipt_ts` (server time, via the column default), not the client's
 * untrusted `ts`; the request origin; and the country/region the edge reports.
 * Location is bound the same way — read from the edge, never from the payload,
 * so a vendor cannot claim to be somewhere they are not.
 *
 * ASN is still deliberately NOT captured. Vercel publishes no autonomous
 * system number on any plan, so it needs either a bundled MaxMind database or
 * a per-event lookup on this hot path, and both were declined explicitly
 * rather than forgotten — see the fraud-check module doc in the countersigner.
 * Country/region is the cheaper substitute and is genuinely weaker: it cannot
 * tell a datacenter from a living room.
 */

import { dbClient } from "@/lib/db/client";
import type { EventType } from "./events";
import type { RequestGeo } from "./geo";

export async function recordObservation(params: {
	vendor: string;
	domain: string;
	ev: EventType;
	cfg: number;
	origin: string;
	geo: RequestGeo;
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
			country: params.geo.country,
			region: params.geo.region,
		});
		if (error) console.error("[letterprove:observe] insert failed", error.message);
	} catch (error) {
		console.error("[letterprove:observe] insert threw", error);
	}
}
