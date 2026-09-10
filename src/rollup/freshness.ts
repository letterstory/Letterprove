/**
 * Watchdog for the failure that looks exactly like success: the published
 * record going stale while nothing throws.
 *
 * The freeze at :05 is what signs and publishes. If it stops being invoked at
 * all, or keeps returning ok while freezing nothing hour after hour, no route
 * 500s and no exception is logged, yet every served attestation keeps its
 * `published_at` and its one hour `ttl` (src/lib/http.ts) as though it were
 * current. That is the product making a freshness claim it can no longer
 * back, which is worse than an outage: an outage is honest.
 *
 * So freshness is measured from the durable record itself rather than from
 * whether a cron reported success. The only thing that proves the freeze is
 * alive is a recent row in the tables the freeze writes.
 */

import { dbClient } from "@/lib/db/client";

const HOUR_SECONDS = 3600;

/**
 * How many hours behind the current hour the newest frozen row may fall
 * before a human is told.
 *
 * The freeze runs hourly at :05, so in a healthy deploy the newest row is 0
 * hours behind for most of the hour and 1 hour behind between :00 and :05. A
 * value of 2 is reachable by a single missed run, which one deploy window or
 * one transient database blip produces and which the next hour heals by
 * itself. Alerting on that trains people to ignore the channel, and an
 * ignored alert is the silence this module exists to end.
 *
 * 3 is the first value that cannot be a single blip: it means two consecutive
 * hourly freezes did not land. A human hears about it roughly two hours after
 * the served `ttl` first started overstating freshness, which is slow enough
 * to be quiet and fast enough that the record has not yet been wrong for a
 * working day.
 */
export const STALE_AFTER_HOURS = 3;

export interface FreshnessCheck {
	/** Which published record this covers, so a Slack line carries its own blast radius. */
	scope: string;
	ok: boolean;
	detail: string;
}

export interface PublicationFreshness {
	ok: boolean;
	checks: FreshnessCheck[];
}

function currentBucket(): number {
	return Math.floor(Date.now() / (HOUR_SECONDS * 1000));
}

/**
 * One indexed single-row read per table. Cheap enough to run on the 15 minute
 * collector-health cadence, which is the point: the check has to live
 * somewhere that keeps running when the hourly crons do not.
 */
async function checkTable(
	db: NonNullable<ReturnType<typeof dbClient>>,
	scope: string,
	table: string,
	bucket: number
): Promise<FreshnessCheck> {
	const { data, error } = await db
		.from(table)
		.select("hour_bucket")
		.order("hour_bucket", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (error) {
		// Not a staleness claim. We do not know whether the record is stale, and
		// saying so is more useful than either silence or a guess.
		return { scope, ok: false, detail: `cannot read ${table}: ${error.message}` };
	}

	// Never written at all is not staleness. Nothing is being served with a
	// freshness claim it cannot back, because nothing is being served. This is
	// also the normal state of `published_snapshots` for a deploy whose vendors
	// have no named customers yet, and paging about that every 15 minutes
	// forever would be the loudest possible way to say nothing.
	if (!data) {
		return { scope, ok: true, detail: `${table} has never been written, so nothing is going stale` };
	}

	const behind = bucket - (data as { hour_bucket: number }).hour_bucket;
	if (behind < STALE_AFTER_HOURS) {
		return { scope, ok: true, detail: `newest frozen hour is ${behind}h behind` };
	}

	return {
		scope,
		ok: false,
		detail:
			`newest frozen hour is ${behind}h behind (threshold ${STALE_AFTER_HOURS}h), so the freeze has missed at ` +
			`least ${behind - 1} consecutive runs. Every vendor is affected: each is still served a published_at ` +
			`that old under a 1h ttl.`,
	};
}

export async function checkPublicationFreshness(): Promise<PublicationFreshness> {
	const db = dbClient();
	if (!db) {
		return {
			ok: false,
			checks: [
				{
					scope: "all published proofs",
					ok: false,
					detail: "no datastore configured, so staleness cannot be measured at all",
				},
			],
		};
	}

	const bucket = currentBucket();
	// Both halves of the published record, checked separately for the same
	// reason the freeze reports them separately: snapshots can stall while
	// aggregates keep publishing, and a single combined verdict would hide
	// whichever half is still healthy and misname the blast radius.
	const checks = await Promise.all([
		checkTable(db, "per-customer snapshots (/attest/{vendor}/{customer})", "published_snapshots", bucket),
		checkTable(db, "vendor aggregates (/attest/{vendor})", "published_aggregates", bucket),
	]);

	return { ok: checks.every((check) => check.ok), checks };
}
