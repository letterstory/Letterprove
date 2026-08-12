/**
 * The hourly freeze — turns each customer's live snapshot into a durable,
 * chained row in published_snapshots. README § Publish: "chained to its
 * predecessor via prev_hash. This is what makes the system auditable."
 *
 * Runs after rollup.ts in the cron schedule (vercel.json), so the hour it
 * freezes already has hot_rollups written for it.
 *
 * Idempotent per (vendor, customer, hour): reruns within the same hour
 * upsert onto that hour's row rather than forking the chain. `prevHash` is
 * always read from the latest row in an *earlier* hour, never the row
 * about to be overwritten — otherwise a rerun would chain the hour onto
 * its own previous version instead of the true predecessor.
 */

import { dbClient } from "@/lib/db/client";
import { attestationBody } from "@/lib/attest/body";
import { signAttestation } from "@/lib/attest/sign";
import { GENESIS_HASH, snapshotHash } from "@/lib/attest/verify";
import { allVendors } from "@/lib/fixtures/vendors";
import type { SignedAttestation } from "@/lib/attest/types";

const HOUR_SECONDS = 3600;

function hourBucket(): number {
	return Math.floor(Date.now() / (HOUR_SECONDS * 1000));
}

export interface FreezeResult {
	ok: boolean;
	frozen: number;
	/** Present when ok is false. */
	detail?: string;
}

export async function freezeSnapshots(): Promise<FreezeResult> {
	const db = dbClient();
	if (!db) return { ok: false, frozen: 0, detail: "no datastore configured" };

	const bucket = hourBucket();
	let frozen = 0;

	for (const vendor of allVendors()) {
		for (const customer of vendor.customers) {
			const { data: last, error: lastError } = await db
				.from("published_snapshots")
				.select("attestation")
				.eq("vendor_slug", vendor.slug)
				.eq("customer_slug", customer.slug)
				.lt("hour_bucket", bucket)
				.order("hour_bucket", { ascending: false })
				.limit(1)
				.maybeSingle();

			if (lastError) return { ok: false, frozen, detail: lastError.message };

			const prevHash = last ? snapshotHash(last.attestation as SignedAttestation) : GENESIS_HASH;
			const body = await attestationBody(vendor, customer);
			const signed = await signAttestation({ ...body, prev_hash: prevHash });

			const { error: upsertError } = await db.from("published_snapshots").upsert(
				{
					vendor_slug: vendor.slug,
					customer_slug: customer.slug,
					hour_bucket: bucket,
					published_at: signed.published_at,
					attestation: signed,
				},
				{ onConflict: "vendor_slug,customer_slug,hour_bucket" }
			);
			if (upsertError) return { ok: false, frozen, detail: upsertError.message };
			frozen++;
		}
	}

	return { ok: true, frozen };
}
