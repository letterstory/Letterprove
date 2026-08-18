/**
 * Reads a vendor's durable aggregate history — the rows the hourly freeze has
 * persisted. Never the whole story alone: the current hour is usually not
 * frozen yet, so attest/aggregate.ts appends one live entry on top.
 *
 * Deliberately mirrors rollup/history.ts rather than generalising it. The two
 * read different tables with different subjects, and a shared "load a chain"
 * helper would need a table name and a key shape passed in, which is more
 * indirection than duplication saves at this size.
 */

import { dbClient } from "@/lib/db/client";
import type { SignedAggregate } from "@/lib/attest/aggregate";

export interface PersistedAggregate {
	hourBucket: number;
	attestation: SignedAggregate;
}

/**
 * Oldest first, matching the chain's own ordering.
 *
 * THROWS on a read failure rather than returning an empty history, for the
 * same reason loadPersistedChain does: an empty array is a real answer that
 * sends the caller back to GENESIS_HASH and publishes a fresh single-entry
 * chain. Doing that after a transient query error would silently discard
 * published history — an agent that fetched before and after sees entries
 * disappear and `prev_hash` change, which is indistinguishable from us quietly
 * rewriting the record. That is the exact accusation the chain exists to
 * refute.
 */
export async function loadAggregateHistory(vendorSlug: string): Promise<PersistedAggregate[]> {
	const db = dbClient();
	// No datastore is a configuration state, not a failure: nothing was ever
	// frozen, so an empty history is the truth.
	if (!db) return [];

	const { data, error } = await db
		.from("published_aggregates")
		.select("hour_bucket, attestation")
		.eq("vendor_slug", vendorSlug)
		.order("hour_bucket", { ascending: true });

	if (error) {
		console.error("[letterprove:aggregate-history] query failed", error.message);
		throw new Error(`cannot read published aggregate history for ${vendorSlug}: ${error.message}`);
	}

	return ((data ?? []) as { hour_bucket: number; attestation: SignedAggregate }[]).map((row) => ({
		hourBucket: row.hour_bucket,
		attestation: row.attestation,
	}));
}
