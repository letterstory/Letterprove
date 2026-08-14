/**
 * Reads a customer's durable attestation history — the rows the hourly
 * freeze (freeze.ts) has persisted so far. Never the whole story on its
 * own: the current hour is usually not frozen yet, so attest/proofs.ts
 * appends one live entry on top of whatever this returns.
 */

import { dbClient } from "@/lib/db/client";
import type { SignedAttestation } from "@/lib/attest/types";

export interface PersistedEntry {
	hourBucket: number;
	attestation: SignedAttestation;
}

/**
 * Oldest first, matching the chain's own ordering.
 *
 * THROWS on a read failure rather than returning an empty history. The two are
 * not interchangeable here: an empty array means "this customer has no frozen
 * history yet", which sends proofs.ts back to GENESIS_HASH and publishes a
 * fresh single-entry chain. Doing that after a transient query error would
 * silently discard real published history — an agent that fetched the chain
 * before and after sees entries disappear and `prev_hash` change, which is
 * indistinguishable from us quietly rewriting the record. That is the exact
 * accusation the chain exists to refute, and the composed result is cached for
 * the hour, so one unlucky read would poison what we serve for a full hour
 * rather than a moment.
 *
 * Failing loudly follows countersign.ts: "an unsigned snapshot must never be
 * published, so let it throw." A 500 is a transient, honest outage; a
 * contradicted chain is a permanent credibility problem.
 */
export async function loadPersistedChain(vendorSlug: string, customerSlug: string): Promise<PersistedEntry[]> {
	const db = dbClient();
	// No datastore is a configuration state, not a failure: nothing was ever
	// frozen, so an empty history is the truth.
	if (!db) return [];

	const { data, error } = await db
		.from("published_snapshots")
		.select("hour_bucket, attestation")
		.eq("vendor_slug", vendorSlug)
		.eq("customer_slug", customerSlug)
		.order("hour_bucket", { ascending: true });

	if (error) {
		console.error("[letterprove:history] query failed", error.message);
		throw new Error(`cannot read published history for ${vendorSlug}/${customerSlug}: ${error.message}`);
	}

	return (data ?? []).map((row: { hour_bucket: number; attestation: SignedAttestation }) => ({
		hourBucket: row.hour_bucket,
		attestation: row.attestation,
	}));
}
