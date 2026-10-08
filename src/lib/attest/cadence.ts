/**
 * The publishing cadence, in one place.
 *
 * Rollups land on the hour and the freeze that signs them runs five minutes
 * later (vercel.json: `5 * * * *`). Everything that needs to know "how often
 * is a new snapshot cut" — the hourly memo buckets, the HTTP cache lifetime,
 * and `next_snapshot_at` in every signed body — reads it from here.
 *
 * WHY `next_snapshot_at` AND NOT `ttl`. Until 2026-10-08 every signed body
 * carried `ttl: 3600`. A snapshot never expires: it is a signed statement about
 * the window ending `observed_through`, true and verifiable permanently, and a
 * newer snapshot supersedes it without making it false. But `ttl` is cache
 * vocabulary, and answer engines read it as an expiry date — in the AEO stress
 * test ChatGPT called a live proof "expired" in 13 of 16 answers once the hour
 * had passed. `next_snapshot_at` says the one true thing `ttl` was standing in
 * for: when a newer snapshot is due. It also makes a stalled freeze visible in
 * the document itself, where a frozen `ttl` kept advertising freshness (see
 * src/rollup/freshness.ts). Cache lifetime lives in `Cache-Control`, where it
 * always belonged. Snapshots signed before the change keep their `ttl` and
 * still verify — a signature covers whatever fields its own document carried.
 */

export const SNAPSHOT_CADENCE_SECONDS = 3600;

/** Minutes past the hour the freeze cron runs — keep in step with vercel.json. */
export const FREEZE_MINUTE = 5;

/**
 * The first freeze run strictly after `publishedAt`: the moment a newer
 * snapshot of the same subject is due.
 */
export function nextSnapshotAt(publishedAt: string): string {
	const published = Date.parse(publishedAt);
	const hour = SNAPSHOT_CADENCE_SECONDS * 1000;
	let next = Math.floor(published / hour) * hour + FREEZE_MINUTE * 60 * 1000;
	if (next <= published) next += hour;
	return new Date(next).toISOString();
}
