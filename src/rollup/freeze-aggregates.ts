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
 * Idempotent per (vendor, hour): a rerun upserts that hour's row rather than
 * forking the chain, and `prevHash` always comes from the latest row in an
 * EARLIER hour — never the row about to be overwritten, or a rerun would chain
 * an hour onto its own previous version.
 */

import { dbClient } from "@/lib/db/client";
import { signAggregate } from "@/lib/attest/aggregate";
import { isDemonstration } from "@/lib/attest/keys";
import { GENESIS_HASH, snapshotHash } from "@/lib/attest/verify";
import { allVendors } from "@/lib/fixtures/vendors";
import type { SignedAggregate } from "@/lib/attest/aggregate";

const HOUR_SECONDS = 3600;

function hourBucket(): number {
	return Math.floor(Date.now() / (HOUR_SECONDS * 1000));
}

export interface AggregateFreezeResult {
	ok: boolean;
	frozen: number;
	/** Vendors deliberately not frozen this run — see the refusals above. */
	skipped?: string[];
	/** Present when ok is false. */
	detail?: string;
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
	const skipped: string[] = [];

	for (const vendor of await allVendors()) {
		const { data: last, error: lastError } = await db
			.from("published_aggregates")
			.select("attestation")
			.eq("vendor_slug", vendor.slug)
			.lt("hour_bucket", bucket)
			.order("hour_bucket", { ascending: false })
			.limit(1)
			.maybeSingle();

		// Scoped to the vendor the run died on, for the same reason freeze.ts
		// scopes its own: the alert built from this detail has to name whose
		// aggregate stopped publishing.
		if (lastError) return { ok: false, frozen, detail: `${vendor.slug}: ${lastError.message}` };

		const prevHash = last ? snapshotHash(last.attestation as SignedAggregate) : GENESIS_HASH;
		const signed = await signAggregate(vendor.slug, prevHash);

		// Null means the vendor is unknown or its telemetry could not be read.
		// Either way there is nothing honest to freeze this hour; the next run
		// picks it up if the read recovers.
		if (!signed) {
			skipped.push(vendor.slug);
			continue;
		}

		const { error: upsertError } = await db.from("published_aggregates").upsert(
			{
				vendor_slug: vendor.slug,
				hour_bucket: bucket,
				published_at: signed.published_at,
				attestation: signed,
			},
			{ onConflict: "vendor_slug,hour_bucket" }
		);
		if (upsertError) return { ok: false, frozen, detail: `${vendor.slug}: ${upsertError.message}` };
		frozen++;
	}

	return { ok: true, frozen, ...(skipped.length && { skipped }) };
}
