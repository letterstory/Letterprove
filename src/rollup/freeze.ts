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
import { isDemonstration } from "@/lib/attest/keys";
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
	/**
	 * Customers deliberately not frozen this run because their telemetry read
	 * failed. Not an error — see the skip in the loop below.
	 */
	skipped?: string[];
	/** Present when ok is false. */
	detail?: string;
}

export async function freezeSnapshots(): Promise<FreezeResult> {
	// Ephemeral dev signing is how this repo is developed; PERSISTING it is a
	// different act. A row written here is chained and immutable, so a
	// dev-key signature frozen into history stays in history — and the moment
	// the real key goes live and the JWKS stops publishing the dev key, every
	// one of those entries fails verification forever. That is not
	// hypothetical: it happened on 2026-08-13, when four frozen hours went
	// permanently unverifiable the instant LETTERPROVE_PRODUCTION_JWK was set.
	// Refusing to freeze is the guard that makes the rotation rule in keys.ts
	// ("keep retired public keys forever") survivable, because it means nothing
	// in the chain was ever signed by a key we intend to stop publishing.
	if (isDemonstration()) {
		return { ok: false, frozen: 0, detail: "refusing to freeze development-key signatures into immutable history" };
	}

	const db = dbClient();
	if (!db) return { ok: false, frozen: 0, detail: "no datastore configured" };

	const bucket = hourBucket();
	let frozen = 0;
	const skipped: string[] = [];

	for (const vendor of await allVendors()) {
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

			// Scoped to the vendor/customer the run died on, not a bare database
			// message. That name is the blast radius the cron route puts in the
			// alert, and without it a human reading Slack knows only that some
			// proof somewhere stopped updating.
			if (lastError) return { ok: false, frozen, detail: `${vendor.slug}/${customer.slug}: ${lastError.message}` };

			const { body, snapshot } = await attestationBody(vendor, customer);

			// A failed telemetry read produces a body indistinguishable from a
			// genuine tier-0: same zeros, same gated tier. Freezing it would
			// record a permanent downgrade for a customer that may have been
			// perfectly healthy, and the chain is immutable, so there is no
			// correcting it afterwards. Skipping leaves this hour unfrozen —
			// the live path still serves a current entry, and the next run
			// picks the hour up if the read recovers.
			if (!snapshot.readOk) {
				skipped.push(`${vendor.slug}/${customer.slug}`);
				continue;
			}

			const prevHash = last ? snapshotHash(last.attestation as SignedAttestation) : GENESIS_HASH;

			/*
			 * Signing failure isolates to ONE customer.
			 *
			 * countersign() throws on every failure path, deliberately — an
			 * unsigned snapshot must never be published, and that part is right.
			 * But the throw used to escape this loop, which meant a single
			 * customer's problem halted the freeze for every customer and vendor
			 * after them. The worst version of that: a fraud-check REFUSAL (403)
			 * is a normal, expected outcome for one bad claim, and it stopped
			 * everyone else's proofs from updating.
			 *
			 * Caught here and treated exactly like the failed-telemetry skip
			 * above: this customer gets no entry for this hour, everyone else
			 * carries on. A missing hour is already a designed-for state — the
			 * chain links by prev_hash, not by contiguous hours, so a gap is a
			 * less dense history rather than a broken one, and the live path
			 * still serves a current entry.
			 */
			let signed;
			try {
				signed = await signAttestation({ ...body, prev_hash: prevHash });
			} catch (error) {
				skipped.push(
					`${vendor.slug}/${customer.slug} (signing: ${error instanceof Error ? error.message : "unknown"})`
				);
				continue;
			}

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
			if (upsertError) return { ok: false, frozen, detail: `${vendor.slug}/${customer.slug}: ${upsertError.message}` };
			frozen++;
		}
	}

	return { ok: true, frozen, ...(skipped.length && { skipped }) };
}
