/**
 * Is collection actually working?
 *
 * The question this exists for has now gone wrong twice, both times silently
 * and both times for days:
 *
 *   2026-08-14  attest.js pointed at a *.vercel.app alias that started 404ing
 *               after Letterprove moved domains. 65 hours, no events.
 *   2026-08-17  #25's migrations never ran, so vendor lookup failed and the
 *               collector rejected every event. ~100 minutes.
 *
 * Neither surfaced on its own. Telemetry fails quietly by design — it must
 * never break a vendor's page — so the only symptom either time was a table
 * that stopped growing, which is indistinguishable from nobody signing in.
 * Both were found by a human happening to look.
 *
 * So this makes "has anything arrived lately" a page rather than a query. It
 * is the operational counterpart to the tier report: that one answers *why is
 * this claim not published*, this one answers *is anything coming in at all*.
 *
 * Deliberately NOT an alert. Alerting on volume is the wrong instrument —
 * a quiet weekend looks identical to a broken install, which is why the
 * lettertrace canary probes the script URL directly instead. This is for the
 * human who is already looking, and it shows the shape rather than a verdict.
 */

import { dbClient } from "@/lib/db/client";
import { allVendors } from "@/lib/fixtures/vendors";

/** Long enough that a quiet evening is not "silent", short enough to matter. */
const SILENT_AFTER_HOURS = 24;

export type CollectionStatus =
	/** Events inside the window. Working. */
	| "reporting"
	/** Has reported before, but nothing lately — the shape both outages had. */
	| "silent"
	/**
	 * attest.js has booted (config_pings) but no identify()/signup()/login()
	 * has ever fired. Not necessarily broken — see status.ts — but distinct
	 * from `never`: the script is present, nothing has just gone wrong.
	 */
	| "installed"
	/** No config ping and no event, ever: the script has not loaded at all. */
	| "never";

export interface VendorHealth {
	vendor: string;
	domain: string;
	customers: number;
	lastEventAt: string | null;
	hoursSinceLastEvent: number | null;
	events24h: number;
	events7d: number;
	events30d: number;
	status: CollectionStatus;
}

function since(hours: number): string {
	return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

export async function collectionHealth(): Promise<VendorHealth[] | null> {
	const db = dbClient();
	// Null rather than an all-zero table: "no datastore" and "nothing arrived"
	// look identical once rendered, and only one of them is an outage.
	if (!db) return null;

	const vendors = await allVendors();
	const rows: VendorHealth[] = [];

	for (const v of vendors) {
		const countSince = async (hours: number) => {
			const { count, error } = await db
				.from("hot_events")
				.select("*", { count: "exact", head: true })
				.eq("vendor_slug", v.slug)
				.gte("receipt_ts", since(hours));
			if (error) {
				console.error("[letterprove:health] count failed", error.message);
				return 0;
			}
			return count ?? 0;
		};

		const { data: latest } = await db
			.from("hot_events")
			.select("receipt_ts")
			.eq("vendor_slug", v.slug)
			.order("receipt_ts", { ascending: false })
			.limit(1);

		const lastEventAt = (latest as { receipt_ts: string }[] | null)?.[0]?.receipt_ts ?? null;
		const hoursSince = lastEventAt
			? (Date.now() - new Date(lastEventAt).getTime()) / 3_600_000
			: null;

		const [events24h, events7d, events30d, { data: ping }] = await Promise.all([
			countSince(24),
			countSince(24 * 7),
			countSince(24 * 30),
			db.from("config_pings").select("vendor_slug").eq("vendor_slug", v.slug).maybeSingle(),
		]);

		rows.push({
			vendor: v.slug,
			domain: v.domain,
			customers: v.customers.length,
			lastEventAt,
			hoursSinceLastEvent: hoursSince,
			events24h,
			events7d,
			events30d,
			status:
				hoursSince !== null
					? hoursSince > SILENT_AFTER_HOURS
						? "silent"
						: "reporting"
					: ping != null
						? "installed"
						: "never",
		});
	}

	// Silent first: a vendor that stopped reporting is the only row here that
	// ever needs acting on, and it should not be buried under healthy ones.
	const order: Record<CollectionStatus, number> = { silent: 0, reporting: 1, installed: 2, never: 3 };
	return rows.sort((a, b) => order[a.status] - order[b.status] || b.events7d - a.events7d);
}
