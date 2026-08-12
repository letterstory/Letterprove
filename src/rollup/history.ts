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

/** Oldest first, matching the chain's own ordering. */
export async function loadPersistedChain(vendorSlug: string, customerSlug: string): Promise<PersistedEntry[]> {
	const db = dbClient();
	if (!db) return [];

	const { data, error } = await db
		.from("published_snapshots")
		.select("hour_bucket, attestation")
		.eq("vendor_slug", vendorSlug)
		.eq("customer_slug", customerSlug)
		.order("hour_bucket", { ascending: true });

	if (error) {
		console.error("[letterprove:history] query failed", error.message);
		return [];
	}

	return (data ?? []).map((row: { hour_bucket: number; attestation: SignedAttestation }) => ({
		hourBucket: row.hour_bucket,
		attestation: row.attestation,
	}));
}
