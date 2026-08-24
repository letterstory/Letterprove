/**
 * One vendor's Stripe sync: read subscriptions, join them to observed usage,
 * store what survived.
 *
 * The three pieces this composes are each testable alone — credentials.ts
 * holds the secret, fetch.ts talks to Stripe, map.ts decides what counts. This
 * file is the wiring and the two policy decisions that only make sense once
 * they are together:
 *
 *   1. A TEST-MODE credential never produces evidence. Test payments are
 *      invented by definition, and a tier-3 claim built from them would be
 *      exactly the false corroboration this tier exists to rule out. The sync
 *      still runs and still reports, so a vendor wiring things up sees their
 *      data flow — it just refuses to store any of it as evidence.
 *
 *   2. Observed domains are read fresh and the map is NOT allowed to skip that
 *      check. mapPayments defaults to fail-closed, and nothing here passes
 *      allowUnobserved, so a vendor with no telemetry gets no payment evidence
 *      rather than all of it.
 */

import { dbClient } from "@/lib/db/client";
import { credentialFor } from "./credentials";
import { fetchSubscriptions } from "./fetch";
import { mapPayments } from "./map";

const OBSERVED_WINDOW_DAYS = 30;

export type SyncResult =
	| {
			ok: true;
			matched: number;
			unmatched: number;
			/** True when a test-mode key meant nothing was stored as evidence. */
			testMode: boolean;
			truncated: boolean;
	  }
	| { ok: false; error: string };

export async function syncVendorPayments(vendorId: string, vendorSlug: string): Promise<SyncResult> {
	const db = dbClient();
	if (!db) return { ok: false, error: "No datastore configured." };

	const credential = await credentialFor(vendorId);
	if (!credential) return { ok: false, error: "No Stripe key connected." };

	const fetched = await fetchSubscriptions(credential.key);
	if (!fetched.ok) {
		await db
			.from("vendor_stripe_credentials")
			.update({ last_sync_error: fetched.error, last_synced_at: new Date().toISOString() })
			.eq("vendor_id", vendorId);
		return { ok: false, error: fetched.error };
	}

	const observed = await observedDomains(vendorSlug);
	const mapping = mapPayments(fetched.subscriptions, observed);

	const syncedAt = new Date().toISOString();

	// A test key is allowed to reach this point precisely so the counts below
	// are real and a vendor can see their wiring works — but nothing is written
	// as evidence, because evidence from test mode is not evidence.
	if (!credential.livemode) {
		await db
			.from("vendor_stripe_credentials")
			.update({ last_synced_at: syncedAt, last_sync_error: null })
			.eq("vendor_id", vendorId);
		return {
			ok: true,
			matched: mapping.matched.length,
			unmatched: mapping.unmatched.length,
			testMode: true,
			truncated: fetched.truncated,
		};
	}

	// Replace rather than merge. A subscription that was cancelled since the
	// last sync must DISAPPEAR from evidence — merging would leave a stale row
	// asserting a customer still pays when they stopped, which is the worst
	// kind of wrong for a signed claim.
	await db.from("vendor_payment_evidence").delete().eq("vendor_id", vendorId);
	await db.from("vendor_payment_unmatched").delete().eq("vendor_id", vendorId);

	if (mapping.matched.length > 0) {
		const { error } = await db.from("vendor_payment_evidence").insert(
			mapping.matched.map((m) => ({
				vendor_id: vendorId,
				domain: m.domain,
				since: m.since,
				currency: m.currency,
				monthly_amount: m.monthlyAmount,
				subscription_count: m.subscriptionCount,
				synced_at: syncedAt,
			}))
		);
		if (error) return { ok: false, error: "Couldn't store payment evidence." };
	}

	if (mapping.unmatched.length > 0) {
		await db.from("vendor_payment_unmatched").insert(
			mapping.unmatched.map((u) => ({
				vendor_id: vendorId,
				subscription_id: u.subscriptionId,
				reason: u.reason,
				domain: u.domain,
				synced_at: syncedAt,
			}))
		);
	}

	await db
		.from("vendor_stripe_credentials")
		.update({ last_synced_at: syncedAt, last_sync_error: null })
		.eq("vendor_id", vendorId);

	return {
		ok: true,
		matched: mapping.matched.length,
		unmatched: mapping.unmatched.length,
		testMode: false,
		truncated: fetched.truncated,
	};
}

/**
 * Domains this vendor has actually been observed serving.
 *
 * Read fresh on every sync rather than cached: the whole point of the join is
 * that payment alone is not evidence about usage, and a stale usage list would
 * let a company that stopped using the product keep its payment-corroborated
 * claim. Returns an empty set on a failed read, which mapPayments treats as
 * "nothing matches" — the safe direction.
 */
async function observedDomains(vendorSlug: string): Promise<Set<string>> {
	const db = dbClient();
	if (!db) return new Set();

	const since = new Date(Date.now() - OBSERVED_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const { data, error } = await db
		.from("hot_rollups")
		.select("domain")
		.eq("vendor_slug", vendorSlug)
		.gte("window_start", since);

	if (error) {
		console.error("[letterprove:stripe-sync] observed-domain read failed", error.message);
		return new Set();
	}

	return new Set((data ?? []).map((r) => (r as { domain: string }).domain));
}
