/**
 * Reads a customer's durable attestation history — the rows the hourly
 * freeze (freeze.ts) has persisted so far. Never the whole story on its
 * own: the current hour is usually not frozen yet, so attest/proofs.ts
 * appends one live entry on top of whatever this returns.
 */

import { readAllRows } from "@/lib/db/read-all";
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

	// Paged, not a bare select. An unbounded read is capped at 1000 rows with no
	// error and no marker, and buildChainFor links the next attestation onto
	// `persisted.at(-1)` — so a truncated history silently chains onto a stale
	// predecessor and forks the chain, in rows that are immutable by design.
	// See src/lib/db/read-all.ts.
	let rows: { hour_bucket: number; attestation: SignedAttestation }[];
	try {
		rows = await readAllRows(`published history for ${vendorSlug}/${customerSlug}`, (from, to) =>
			db
				.from("published_snapshots")
				.select("hour_bucket, attestation")
				.eq("vendor_slug", vendorSlug)
				.eq("customer_slug", customerSlug)
				.order("hour_bucket", { ascending: true })
				.range(from, to),
		);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		console.error("[letterprove:history] query failed", message);
		throw new Error(`cannot read ${message}`);
	}

	return rows.map((row) => ({
		hourBucket: row.hour_bucket,
		attestation: row.attestation,
	}));
}
