import { dbClient } from "@/lib/db/client";
import { registrableDomain } from "@/lib/vendors/custom-domain";

/**
 * Events /v1/observe dropped because of where they came from, counted so the
 * vendor can be told. Origin host and a count per day, nothing else: the
 * payload (a user's company domain) is never kept for a dropped event.
 *
 * Best effort. A failed write must not change what the collector answers, so
 * errors are swallowed; the worst case is a setup hint that shows up late.
 */
export async function recordRejectedOrigin(vendorId: string | undefined, origin: string): Promise<void> {
	if (!vendorId) return;
	const db = dbClient();
	if (!db) return;
	try {
		await db.rpc("record_rejected_origin", { p_vendor_id: vendorId, p_origin: origin.slice(0, 253) });
	} catch {
		// see above
	}
}

export type RejectedReason = "development" | "needs_proof" | "other_company";

export interface RejectedOrigin {
	host: string;
	events_24h: number;
	last_at: string;
	/** True when add_host can make it accepted: a sibling on the same registrable domain. */
	addable: boolean;
	reason: RejectedReason;
}

const DEV = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$|\.vercel\.app$|\.netlify\.app$|\.local$|\.ngrok(-free)?\.app$/;

/** Pure: why an origin isn't accepted, and whether adding it would help. */
export function classifyRejected(host: string, vendorDomain: string): { addable: boolean; reason: RejectedReason } {
	if (DEV.test(host)) return { addable: false, reason: "development" };
	if (registrableDomain(host) === registrableDomain(vendorDomain)) return { addable: true, reason: "needs_proof" };
	return { addable: false, reason: "other_company" };
}

/** Origins dropped in the last 24 hours, busiest first. Empty on any read failure. */
export async function rejectedOriginsFor(vendorId: string, vendorDomain: string): Promise<RejectedOrigin[]> {
	const db = dbClient();
	if (!db) return [];
	const since = Date.now() - 24 * 60 * 60 * 1000;
	const today = new Date().toISOString().slice(0, 10);
	const yesterday = new Date(since).toISOString().slice(0, 10);
	const { data, error } = await db
		.from("vendor_rejected_origins")
		.select("origin, count, last_at, day")
		.eq("vendor_id", vendorId)
		.in("day", [...new Set([today, yesterday])]);
	if (error || !data) return [];

	const byHost = new Map<string, { events: number; last: string }>();
	for (const r of data as { origin: string; count: number; last_at: string }[]) {
		if (Date.parse(r.last_at) < since) continue;
		const prev = byHost.get(r.origin);
		byHost.set(r.origin, {
			events: (prev?.events ?? 0) + Number(r.count),
			last: prev && prev.last > r.last_at ? prev.last : r.last_at,
		});
	}
	return [...byHost.entries()]
		.map(([host, v]) => ({ host, events_24h: v.events, last_at: new Date(v.last).toISOString(), ...classifyRejected(host, vendorDomain) }))
		.sort((a, b) => b.events_24h - a.events_24h)
		.slice(0, 10);
}
