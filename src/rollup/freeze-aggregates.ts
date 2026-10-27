/**
 * The hourly aggregate freeze — makes the vendor-level claim auditable.
 *
 * Its per-customer counterpart is freeze.ts. This one exists because the
 * aggregate was the only thing Letterprove actually publishes and the only
 * thing with no history: every request rebuilt a single entry from
 * GENESIS_HASH, so the claim was signed but not auditable. README § Signing
 * draws exactly that line.
 *
 * Runs alongside the snapshot freeze, on the same cadence and with the same
 * two refusals, which are the ones that have already cost us:
 *
 *   - Never persist a development-key signature. Frozen rows are immutable, so
 *     a dev-signed entry stays in the chain and fails verification forever once
 *     the JWKS stops publishing that key. That is not hypothetical (2026-08-13).
 *   - Never persist a claim built on a failed telemetry read. `aggregateBody`
 *     already returns null rather than reporting "0 companies observed", and a
 *     signed zero is a wrong claim rather than a missing one.
 *
 * INSERT-ONLY, for the reason in freeze.ts: these rows are the only thing the
 * aggregate routes serve, so a row that exists has been handed out and must
 * never change. A rerun in the same hour skips a vendor already frozen; the
 * write is ON CONFLICT DO NOTHING for overlapping runs; a database trigger
 * refuses UPDATE. `prevHash` comes from the latest row in an EARLIER hour.
 *
 * One vendor's failure never costs another vendor its hour. A countersign
 * refusal or timeout, or a database error, on one vendor is recorded against
 * that vendor and the loop moves on; the run reports not ok, naming each one.
 */

import { dbClient } from "@/lib/db/client";
import { signAggregate } from "@/lib/attest/aggregate";
import { isDemonstration } from "@/lib/attest/keys";
import { GENESIS_HASH, snapshotHash } from "@/lib/attest/verify";
import { allVendors } from "@/lib/fixtures/vendors";
import type { SignedAggregate } from "@/lib/attest/aggregate";
import { autoListOnFirstData } from "@/lib/vendors/listing";

const HOUR_SECONDS = 3600;

function hourBucket(): number {
	return Math.floor(Date.now() / (HOUR_SECONDS * 1000));
}

export interface AggregateFreezeResult {
	ok: boolean;
	frozen: number;
	/** Vendors whose row for this hour already existed and was left untouched. */
	alreadyFrozen?: number;
	/** Vendors deliberately not frozen this run — see the refusals above. */
	skipped?: string[];
	/** Present when ok is false. */
	detail?: string;
	/** Vendors that failed this run, each `slug: reason`. ok is false when any did. */
	failed?: string[];
}

export async function freezeAggregates(): Promise<AggregateFreezeResult> {
	if (isDemonstration()) {
		return {
			ok: false,
			frozen: 0,
			detail: "refusing to freeze development-key signatures into immutable history",
		};
	}

	const db = dbClient();
	if (!db) return { ok: false, frozen: 0, detail: "no datastore configured" };

	const bucket = hourBucket();
	let frozen = 0;
	let alreadyFrozen = 0;
	const skipped: string[] = [];

	const failed: string[] = [];

	for (const vendor of await allVendors()) {
		try {
			const outcome = await freezeVendor(db, vendor.slug, bucket);
			if (outcome === "frozen") frozen++;
			else if (outcome === "already") alreadyFrozen++;
			else skipped.push(vendor.slug);
		} catch (error) {
			// Scoped to the vendor, for the same reason freeze.ts scopes its own:
			// the alert built from this has to name whose aggregate stopped publishing.
			failed.push(`${vendor.slug}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		ok: failed.length === 0,
		frozen,
		...(alreadyFrozen && { alreadyFrozen }),
		...(skipped.length && { skipped }),
		...(failed.length && { failed, detail: failed.join("; ") }),
	};
}

/** One vendor's hour. Throws on a database or countersign failure. */
async function freezeVendor(
	db: NonNullable<ReturnType<typeof dbClient>>,
	slug: string,
	bucket: number
): Promise<"frozen" | "already" | "skipped"> {
	const { data: last, error: lastError } = await db
		.from("published_aggregates")
		.select("hour_bucket, attestation")
		.eq("vendor_slug", slug)
		.lte("hour_bucket", bucket)
		.order("hour_bucket", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (lastError) throw new Error(lastError.message);

	// This hour is already frozen, and has very likely been served.
	if (last?.hour_bucket === bucket) return "already";

	const prevHash = last ? snapshotHash(last.attestation as SignedAggregate) : GENESIS_HASH;
	const signed = await signAggregate(slug, prevHash);

	// Null means the vendor is unknown or its telemetry could not be read.
	// Either way there is nothing honest to freeze this hour; the next run
	// picks it up if the read recovers.
	if (!signed) return "skipped";

	const { error: upsertError } = await db.from("published_aggregates").upsert(
		{
			vendor_slug: slug,
			hour_bucket: bucket,
			published_at: signed.published_at,
			attestation: signed,
		},
		// ON CONFLICT DO NOTHING: an overlapping run that froze this hour first wins.
		{ onConflict: "vendor_slug,hour_bucket", ignoreDuplicates: true }
	);
	if (upsertError) throw new Error(upsertError.message);
	// A new proof waiting for data joins the directory with its first
	// snapshot that has sign-ins (src/lib/vendors/listing.ts). Best effort:
	// a failed listing update never fails the freeze; the next hour retries.
	await autoListOnFirstData(db, slug, signed.companies_observed);
	return "frozen";
}
