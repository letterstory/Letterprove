/**
 * One vendor's PostHog read: which company domains their own analytics has
 * identified people from, since when, and how active each was in the last 30
 * days. Stored privately; published only as counts (see reportedHistory in
 * src/lib/attest/vendor-evidence.ts).
 *
 * Policy, in the order it applies:
 *
 *   1. Only company domains are kept. Free mail, our own domains and malformed
 *      ones are counted and dropped, by the same classifier the attestation
 *      uses (lib/identity/domains.ts).
 *   2. The project has to track the vendor's product: events on its verified
 *      domain or accepted hosts in the last 30 days. The count is stored
 *      either way; history from a project with none is never published.
 *   3. Replace, never merge, so a domain PostHog forgot (deleted persons)
 *      disappears here too.
 *   4. Failures count. After three in a row the stored history is cleared:
 *      history a vendor can stop us refreshing is history they control. The
 *      publish side also refuses anything older than two days.
 */

import { dbClient } from "@/lib/db/client";
import { readAllRows } from "@/lib/db/read-all";
import { partitionDomains } from "@/lib/identity/domains";
import { acceptedHosts } from "@/lib/vendors/hosts";
import { normalizeDomain } from "@/lib/vendors/domain";
import { credentialFor } from "./credentials";
import { ACTIVITY_QUERY, HISTORY_QUERY, ROW_LIMIT, hogql, hostEventsQuery, parseActivity, parseHistory } from "./fetch";

const FAILURES_BEFORE_CLEARING = 3;
const INSERT_CHUNK = 500;

export type PosthogSyncResult =
	| { ok: true; companies: number; activeCompanies30d: number; excluded: number; hostEvents30d: number; truncated: boolean }
	| { ok: false; error: string };

export interface MergedDomain {
	domain: string;
	firstSeen: string | null;
	people: number;
	activePeople30d: number;
	sessions30d: number;
	lastSeen: string | null;
}

/** Join the history and activity reads on domain. Pure, for the test. */
export function mergeRows(
	history: ReturnType<typeof parseHistory>,
	activity: ReturnType<typeof parseActivity>,
): MergedDomain[] {
	const byDomain = new Map<string, MergedDomain>();
	const get = (domain: string) => {
		let row = byDomain.get(domain);
		if (!row) {
			row = { domain, firstSeen: null, people: 0, activePeople30d: 0, sessions30d: 0, lastSeen: null };
			byDomain.set(domain, row);
		}
		return row;
	};
	for (const h of history) {
		const row = get(h.domain);
		row.people += h.people;
		if (h.firstSeen && (!row.firstSeen || h.firstSeen < row.firstSeen)) row.firstSeen = h.firstSeen;
	}
	for (const a of activity) {
		const row = get(a.domain);
		row.activePeople30d += a.people;
		row.sessions30d += a.sessions;
		if (a.lastSeen && (!row.lastSeen || a.lastSeen > row.lastSeen)) row.lastSeen = a.lastSeen;
		// Someone active this month was a person before this month, even when the
		// persons read capped out before reaching their domain.
		if (row.people < a.people) row.people = a.people;
	}
	return [...byDomain.values()];
}

export async function syncVendorPosthog(vendorId: string): Promise<PosthogSyncResult> {
	const db = dbClient();
	if (!db) return { ok: false, error: "No datastore configured." };

	const credential = await credentialFor(vendorId);
	if (!credential) return { ok: false, error: "No PostHog key connected." };

	const { data: vendor } = await db.from("vendors").select("domain").eq("id", vendorId).maybeSingle();
	const vendorDomain = normalizeDomain(vendor?.domain ?? null);
	if (!vendorDomain) return recordFailure(vendorId, "The vendor has no domain to match PostHog events against.");
	const hosts = [vendorDomain, ...(await acceptedHosts(vendorId))];

	// Sequential: these run against the vendor's PostHog query rate limit.
	const hostRead = await hogql(credential, hostEventsQuery(hosts));
	if (!hostRead.ok) return recordFailure(vendorId, hostRead.error);
	const historyRead = await hogql(credential, HISTORY_QUERY);
	if (!historyRead.ok) return recordFailure(vendorId, historyRead.error);
	const activityRead = await hogql(credential, ACTIVITY_QUERY);
	if (!activityRead.ok) return recordFailure(vendorId, activityRead.error);

	const hostEvents30d = Math.max(0, Math.floor(Number(hostRead.rows[0]?.[0]) || 0));
	const history = parseHistory(historyRead.rows);
	const activity = parseActivity(activityRead.rows);
	const truncated = historyRead.rows.length >= ROW_LIMIT || activityRead.rows.length >= ROW_LIMIT;

	const merged = mergeRows(history, activity);
	const { attributable, excluded } = partitionDomains(
		merged.map((m) => m.domain),
		vendorDomain,
	);
	const keep = new Set(attributable);
	const rows = merged.filter((m) => keep.has(m.domain));

	const syncedAt = new Date().toISOString();
	const cleared = await db.from("vendor_posthog_domains").delete().eq("vendor_id", vendorId);
	if (cleared.error) return recordFailure(vendorId, "Couldn't replace stored PostHog history.");
	for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
		const { error } = await db.from("vendor_posthog_domains").insert(
			rows.slice(i, i + INSERT_CHUNK).map((r) => ({
				vendor_id: vendorId,
				domain: r.domain,
				first_seen: r.firstSeen,
				people: r.people,
				active_people_30d: r.activePeople30d,
				sessions_30d: r.sessions30d,
				last_seen: r.lastSeen,
				synced_at: syncedAt,
			})),
		);
		if (error) {
			await db.from("vendor_posthog_domains").delete().eq("vendor_id", vendorId);
			return recordFailure(vendorId, "Couldn't store PostHog history.");
		}
	}

	await db
		.from("vendor_posthog_credentials")
		.update({
			last_synced_at: syncedAt,
			last_sync_error: null,
			consecutive_sync_failures: 0,
			host_events_30d: hostEvents30d,
			domains_excluded: excluded.length,
			truncated,
		})
		.eq("vendor_id", vendorId);

	return {
		ok: true,
		companies: rows.length,
		activeCompanies30d: rows.filter((r) => r.activePeople30d > 0).length,
		excluded: excluded.length,
		hostEvents30d,
		truncated,
	};
}

async function recordFailure(vendorId: string, error: string): Promise<PosthogSyncResult> {
	const db = dbClient();
	if (!db) return { ok: false, error };
	const { data } = await db
		.from("vendor_posthog_credentials")
		.select("consecutive_sync_failures")
		.eq("vendor_id", vendorId)
		.maybeSingle();
	const failures = (Number(data?.consecutive_sync_failures) || 0) + 1;
	await db
		.from("vendor_posthog_credentials")
		.update({ last_sync_error: error, consecutive_sync_failures: failures })
		.eq("vendor_id", vendorId);
	if (failures >= FAILURES_BEFORE_CLEARING) {
		await db.from("vendor_posthog_domains").delete().eq("vendor_id", vendorId);
	}
	return { ok: false, error };
}

export interface PosthogSyncRun {
	ok: boolean;
	attempted: number;
	synced: number;
	failures: { vendorSlug: string; detail: string }[];
	detail?: string;
}

/** Every connected vendor, sequentially, each failure named. Same shape as the Stripe run. */
export async function syncAllVendorPosthog(): Promise<PosthogSyncRun> {
	const db = dbClient();
	if (!db) return { ok: false, attempted: 0, synced: 0, failures: [], detail: "no datastore configured" };

	let connected: { vendor_id: string }[];
	let vendors: { id: string; slug: string }[];
	try {
		connected = await readAllRows<{ vendor_id: string }>("vendors with a PostHog credential", (from, to) =>
			db.from("vendor_posthog_credentials").select("vendor_id").order("vendor_id", { ascending: true }).range(from, to),
		);
		vendors = await readAllRows<{ id: string; slug: string }>("vendor slugs", (from, to) =>
			db.from("vendors").select("id, slug").order("id", { ascending: true }).range(from, to),
		);
	} catch (e) {
		return {
			ok: false,
			attempted: 0,
			synced: 0,
			failures: [],
			detail: `could not list vendors with a PostHog credential: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
	const slugById = new Map(vendors.map((v) => [v.id, v.slug]));

	const run: PosthogSyncRun = { ok: true, attempted: connected.length, synced: 0, failures: [] };
	for (const { vendor_id } of connected) {
		const vendorSlug = slugById.get(vendor_id) ?? vendor_id;
		try {
			const result = await syncVendorPosthog(vendor_id);
			if (result.ok) run.synced++;
			else run.failures.push({ vendorSlug, detail: result.error });
		} catch (e) {
			run.failures.push({ vendorSlug, detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
	run.ok = run.failures.length === 0;
	return run;
}
