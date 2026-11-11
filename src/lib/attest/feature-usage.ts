/**
 * Feature usage: which features of the vendor's product companies use, as counts (2026-11-11, Casey and Mathew:
 * "⌘L usage data will essentially be the proof for proofs").
 *
 * WHERE IT COMES FROM. Letter's Visitors script runs on the vendor's own product and, where the vendor says who is
 * signed in, counts which links and buttons signed-in people click (Letter's visitors_get_feature_usage). Letter
 * pushes each feature's company domains here daily (report_feature_usage). The vendor picks which features its proof
 * shows (set_feature_proofs); nothing shows until it does.
 *
 * WHAT IS PUBLISHED. Per shown feature: `companies`, how many of the companies Letter's script saw signed in used it,
 * and `people`, the signed-in people Letter counted; and `companies_signed_in`, every company Letter reported in the
 * window. Letter's sign-ins count on their own (2026-11-11, Mathew: one install, not two): a vendor with Letter's
 * script on its product needs no Letterprove script for this section. Only company domains count (no free mail, not
 * the vendor's own, partitionDomains). The vendor runs the script that counts, as it runs Letterprove's, so the
 * section is listed in `vendor_stated` and never moves the tier, like `reported_history`. Absent unless the domain is
 * proven (site or DNS), the push is under two days old, and at least one shown feature has a company.
 */

import { dbClient } from "@/lib/db/client";
import { partitionDomains } from "@/lib/identity/domains";

/** A push older than this reads as absent: Letter pushes daily, so two days is one missed run. */
export const MAX_FEATURE_USAGE_AGE_MS = 48 * 60 * 60 * 1000;
/** At most this many features on a proof, the most companies first. */
export const MAX_SHOWN_FEATURES = 10;
/** At most this many features stored per vendor. */
export const MAX_REPORTED_FEATURES = 200;

export interface FeatureUsage {
	/** Where the counts came from: Letter's Visitors script on the vendor's product. */
	source: "letter_visitors";
	window_days: number;
	/** Every company Letter reported signed in over the window (any feature, shown or not). */
	companies_signed_in: number;
	/** The shown features, the most companies first. */
	features: { name: string; companies: number; people: number }[];
}

export interface FeatureRow {
	feature_key: string;
	label: string;
	people: number;
	domains: string[];
	published: boolean;
	synced_at: string;
}

/** Pure: the company domains among a report's domains (no free mail, not the vendor's own), once each. */
export function companyDomains(domains: Iterable<string>, vendorDomain: string): string[] {
	const own = vendorDomain.trim().toLowerCase().replace(/^www\./, "");
	return partitionDomains(new Set(domains), vendorDomain).attributable.filter((d) => d !== own && !d.endsWith(`.${own}`));
}

/** Pure: the published section from the stored rows. Null when nothing would show. */
export function featureUsageSection(rows: readonly FeatureRow[], vendorDomain: string, windowDays: number, now = Date.now()): FeatureUsage | null {
	const fresh = rows.filter((r) => now - Date.parse(r.synced_at) <= MAX_FEATURE_USAGE_AGE_MS);
	const features = fresh
		.filter((r) => r.published)
		.map((r) => ({
			name: r.label,
			companies: companyDomains(r.domains, vendorDomain).length,
			people: Math.max(0, Math.trunc(r.people)),
		}))
		.filter((f) => f.companies > 0)
		.sort((a, b) => b.companies - a.companies || b.people - a.people || a.name.localeCompare(b.name))
		.slice(0, MAX_SHOWN_FEATURES);
	if (!features.length) return null;
	const signedIn = companyDomains(fresh.flatMap((r) => r.domains), vendorDomain).length;
	return { source: "letter_visitors", window_days: windowDays, companies_signed_in: signedIn, features };
}

export async function readFeatureRows(vendorId: string): Promise<FeatureRow[] | null> {
	const db = dbClient();
	if (!db) return null;
	// Any failure reads as null: the section is left out, never published from a partial read.
	try {
		const { data, error } = await db
			.from("vendor_feature_usage")
			.select("feature_key, label, people, domains, published, synced_at")
			.eq("vendor_id", vendorId)
			.order("feature_key", { ascending: true })
			.limit(MAX_REPORTED_FEATURES);
		if (error) return null;
		return (data ?? []) as FeatureRow[];
	} catch {
		return null;
	}
}

/** The section for one vendor's next snapshot; null on any read failure (absent, never a confident zero). */
export async function featureUsage(vendorId: string, vendorDomain: string, windowDays: number): Promise<FeatureUsage | null> {
	const rows = await readFeatureRows(vendorId);
	return rows ? featureUsageSection(rows, vendorDomain, windowDays) : null;
}

export interface ReportedFeature {
	key: string;
	label: string;
	people: number;
	domains: string[];
}

/**
 * Store Letter's push: each feature's counts replaced, the vendor's choice of what to show kept. A feature stored
 * before and missing from this push used by nobody now: its counts go to zero.
 */
export async function saveFeatureUsage(vendorId: string, features: readonly ReportedFeature[]): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;
	const syncedAt = new Date().toISOString();
	const keys = new Set(features.map((f) => f.key));
	const rows = features.slice(0, MAX_REPORTED_FEATURES).map((f) => ({
		vendor_id: vendorId,
		feature_key: f.key,
		label: f.label,
		people: f.people,
		domains: [...new Set(f.domains)],
		synced_at: syncedAt,
	}));
	if (rows.length) {
		const { error } = await db.from("vendor_feature_usage").upsert(rows, { onConflict: "vendor_id,feature_key" });
		if (error) return false;
	}
	const existing = await readFeatureRows(vendorId);
	if (!existing) return false;
	const gone = existing.filter((r) => !keys.has(r.feature_key)).map((r) => r.feature_key);
	if (gone.length) {
		const { error } = await db
			.from("vendor_feature_usage")
			.update({ people: 0, domains: [], synced_at: syncedAt })
			.eq("vendor_id", vendorId)
			.in("feature_key", gone);
		if (error) return false;
	}
	return true;
}

/** Show exactly these features on the proof (by key); every other is hidden. Returns the keys it didn't know. */
export async function setFeatureProofs(vendorId: string, shown: readonly string[]): Promise<{ ok: boolean; unknown: string[] }> {
	const db = dbClient();
	if (!db) return { ok: false, unknown: [] };
	const rows = await readFeatureRows(vendorId);
	if (!rows) return { ok: false, unknown: [] };
	const known = new Set(rows.map((r) => r.feature_key));
	const want = new Set(shown);
	const unknown = [...want].filter((k) => !known.has(k));
	const on = rows.filter((r) => want.has(r.feature_key)).map((r) => r.feature_key);
	const off = rows.filter((r) => !want.has(r.feature_key) && r.published).map((r) => r.feature_key);
	if (on.length) {
		const { error } = await db.from("vendor_feature_usage").update({ published: true }).eq("vendor_id", vendorId).in("feature_key", on);
		if (error) return { ok: false, unknown };
	}
	if (off.length) {
		const { error } = await db.from("vendor_feature_usage").update({ published: false }).eq("vendor_id", vendorId).in("feature_key", off);
		if (error) return { ok: false, unknown };
	}
	return { ok: true, unknown };
}
