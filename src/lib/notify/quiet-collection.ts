import { dbClient } from "@/lib/db/client";
import { notifyVendor } from "./vendor-email";

/** Quiet this long, after having received before, is worth an email. */
export const QUIET_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Vendors whose collection went quiet: verified, with a contact, that have
 * received an event before but none in the last 48 hours. Each is emailed once
 * per quiet spell; the incident key is the last event seen, so a vendor who
 * recovers and goes quiet again is told again.
 *
 * Runs from the collector-health cron. Never throws.
 */
export async function notifyQuietVendors(now: Date = new Date()): Promise<{ checked: number; notified: string[] }> {
	const out = { checked: 0, notified: [] as string[] };
	const db = dbClient();
	if (!db) return out;
	try {
		const { data, error } = await db
			.from("vendors")
			.select("id, slug, first_event_at, contact_email, domain_verified_at")
			.not("first_event_at", "is", null)
			.not("domain_verified_at", "is", null)
			.not("contact_email", "is", null);
		if (error || !data) return out;
		for (const v of data as { id: string; slug: string; first_event_at: string }[]) {
			out.checked++;
			const { data: latest } = await db
				.from("hot_events")
				.select("receipt_ts")
				.eq("vendor_slug", v.slug)
				.order("receipt_ts", { ascending: false })
				.limit(1)
				.maybeSingle<{ receipt_ts: string }>();
			const last = latest?.receipt_ts ?? v.first_event_at;
			if (now.getTime() - Date.parse(last) < QUIET_AFTER_MS) continue;
			const result = await notifyVendor(v.id, "collection_quiet", new Date(last).toISOString());
			if (result === "sent") out.notified.push(v.slug);
		}
	} catch (e) {
		console.error("[letterprove:notify] quiet check failed", e instanceof Error ? e.message : String(e));
	}
	return out;
}
