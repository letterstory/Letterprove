/**
 * The one answer every PostHog tool gives: the connection, what it last read,
 * and whether that history is on the proof (and if not, why).
 */

import { dbClient } from "@/lib/db/client";
import { readAllRows } from "@/lib/db/read-all";
import { MAX_HISTORY_AGE_MS } from "@/lib/attest/vendor-evidence";
import { connectionFor } from "./credentials";

export async function posthogStatus(vendorId: string) {
	const connection = await connectionFor(vendorId);
	if (!connection) return null;
	const db = dbClient();

	let rows: { first_seen: string | null; active_people_30d: number }[] = [];
	if (db) {
		try {
			rows = await readAllRows(`posthog summary for ${vendorId}`, (from, to) =>
				db
					.from("vendor_posthog_domains")
					.select("first_seen, active_people_30d")
					.eq("vendor_id", vendorId)
					.order("domain", { ascending: true })
					.range(from, to),
			);
		} catch {
			rows = [];
		}
	}
	const since = rows
		.map((r) => (r.first_seen ? Date.parse(r.first_seen) : NaN))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b)[0];

	const { data: vendor } = db
		? await db.from("vendors").select("domain_verified_at").eq("id", vendorId).maybeSingle()
		: { data: null };

	const unpublishedReason = !connection.lastSyncedAt
		? "Not synced yet."
		: Date.now() - Date.parse(connection.lastSyncedAt) > MAX_HISTORY_AGE_MS
			? "The last successful sync is more than two days old."
			: !vendor?.domain_verified_at
				? "Your domain isn't verified by DNS yet."
				: !(Number(connection.hostEvents30d) > 0)
					? "This PostHog project has no events on your verified domain or accepted hosts in the last 30 days."
					: rows.length === 0
						? "PostHog hasn't identified anyone at a company domain."
						: null;

	return {
		connected: true as const,
		last4: connection.last4,
		api_host: connection.apiHost,
		project_id: connection.projectId,
		connected_at: connection.connectedAt,
		last_synced_at: connection.lastSyncedAt,
		last_sync_error: connection.lastSyncError,
		host_events_30d: connection.hostEvents30d,
		companies: rows.length,
		active_companies_30d: rows.filter((r) => Number(r.active_people_30d) > 0).length,
		since: since ? new Date(since).toISOString() : null,
		domains_excluded: connection.domainsExcluded,
		truncated: connection.truncated,
		published: unpublishedReason === null,
		unpublished_reason: unpublishedReason,
	};
}
