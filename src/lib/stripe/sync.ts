/**
 * One vendor's Stripe sync: read subscriptions and the invoices that settled,
 * join them to observed usage, store what survived.
 *
 * The three pieces this composes are each testable alone — credentials.ts
 * holds the secret, fetch.ts talks to Stripe, map.ts decides what counts. This
 * file is the wiring and the policy decisions that only make sense once they
 * are together:
 *
 *   1. A TEST-MODE credential never produces evidence. Test payments are
 *      invented by definition, and a tier-3 claim built from them would be
 *      exactly the false corroboration this tier exists to rule out. The sync
 *      still runs and still reports, so a vendor wiring things up sees their
 *      data flow — it just refuses to store any of it as evidence.
 *      It also CLEARS any evidence already standing, because a vendor whose
 *      connected key is a test key has nothing corroborating them right now,
 *      whatever a previous key once proved.
 *
 *   2. Observed domains are read fresh and the map is NOT allowed to skip that
 *      check. mapPayments defaults to fail-closed, and nothing here passes
 *      allowUnobserved, so a vendor with no telemetry gets no payment evidence
 *      rather than all of it.
 *
 *   3. A FAILED SYNC EVENTUALLY CLEARS EVIDENCE. It used to do the opposite:
 *      it stamped `last_synced_at` on the way out and left the rows standing,
 *      so a vendor who revoked their own Stripe key froze a favourable claim in
 *      place permanently and the only consequence was an alert addressed to
 *      them. Evidence a vendor can stop us from refreshing is evidence they
 *      control. Consecutive failures are counted, the count clears the rows
 *      once it passes the threshold, and `last_synced_at` now means what it
 *      says: the last time a sync actually succeeded.
 */

import { readAllRows } from "@/lib/db/read-all";
import { dbClient } from "@/lib/db/client";
import { credentialFor } from "./credentials";
import { fetchPaidInvoices, fetchSubscriptions } from "./fetch";
import { mapPayments } from "./map";

const OBSERVED_WINDOW_DAYS = 30;

/**
 * Consecutive failed syncs before standing evidence is deleted.
 *
 * The cron runs hourly, so three is three hours of a claim we can no longer
 * corroborate — long enough that a Stripe blip or one expired token does not
 * wipe a vendor's proof, short enough that revoking a key is not a way to
 * freeze a favourable claim. It is a backstop rather than the main defence:
 * `paymentEvidenceFor` already refuses to read a row older than a day, so the
 * claim stops publishing well before this deletes anything.
 */
const FAILURES_BEFORE_CLEARING = 3;

/** What the vendor is told when their restricted key predates the invoice read. */
const SCOPE_HELP =
	"Your Stripe restricted key cannot read Invoices, and payment evidence now requires an invoice that actually settled. Add read access to Invoices on the key in Stripe, then sync again.";

export type SyncResult =
	| {
			ok: true;
			matched: number;
			unmatched: number;
			/** True when a test-mode key meant nothing was stored as evidence. */
			testMode: boolean;
			truncated: boolean;
			/**
			 * Set only on a test key whose restricted key cannot read Invoices.
			 * The sync succeeded in the only sense available to a test key, and
			 * the vendor has something to fix before a live key would work. It is
			 * carried back rather than alerted because nothing is at risk yet.
			 */
			scopeWarning?: string;
	  }
	| { ok: false; error: string };

export async function syncVendorPayments(vendorId: string, vendorSlug: string): Promise<SyncResult> {
	const db = dbClient();
	if (!db) return { ok: false, error: "No datastore configured." };

	const credential = await credentialFor(vendorId);
	if (!credential) return { ok: false, error: "No Stripe key connected." };

	const fetched = await fetchSubscriptions(credential.key);
	if (!fetched.ok) return recordFailure(vendorId, fetched.error);

	// The corroboration read. A subscription says what a vendor means to bill;
	// only an invoice says money moved, and tier 3's entire claim is the second
	// thing. A failure here is a failed sync, not a sync that publishes the
	// weaker evidence: falling back to subscriptions alone would mean a vendor
	// could get the old, forgeable behaviour back by breaking one permission.
	const invoices = await fetchPaidInvoices(credential.key);
	if (!invoices.ok) {
		// A missing Invoices scope on a TEST key is not a failed sync, and must
		// not page anyone. Nothing is at risk: a test key writes no evidence
		// whatever it can read, so there is no published claim to go stale and
		// nothing a human on our side can or should do at 3am. It is a real
		// thing the vendor has to fix before a live key will work, so it travels
		// back as a warning they can see rather than an alert we swallow.
		//
		// This is the shape the tier-3 change got wrong: it put a required read
		// in front of the branch below, whose whole purpose is to let a vendor
		// confirm their wiring works before they have anything to prove. The
		// first vendor to connect a test key paged the alert channel hourly for
		// thirteen hours about a permission that would not have changed one
		// stored row.
		if (!credential.livemode && invoices.scope) {
			await clearEvidence(vendorId);
			await recordSuccess(vendorId, new Date().toISOString());
			return {
				ok: true,
				matched: 0,
				unmatched: 0,
				testMode: true,
				truncated: fetched.truncated,
				scopeWarning: SCOPE_HELP,
			};
		}
		return recordFailure(vendorId, invoices.scope ? SCOPE_HELP : invoices.error);
	}

	const observed = await observedDomains(vendorSlug);
	const { data: vendorRow } = await db.from("vendors").select("domain").eq("id", vendorId).maybeSingle();
	const mapping = mapPayments(fetched.subscriptions, observed, invoices.payments, {
		vendorDomain: vendorRow?.domain,
	});

	const syncedAt = new Date().toISOString();
	const truncated = fetched.truncated || invoices.truncated;

	// A test key is allowed to reach this point precisely so the counts below
	// are real and a vendor can see their wiring works — but nothing is written
	// as evidence, because evidence from test mode is not evidence.
	if (!credential.livemode) {
		// Clears rather than merely skipping. A vendor who swaps a live key for
		// a test one would otherwise keep publishing the live key's evidence
		// forever: the live path replaces evidence wholesale on every sync, and
		// this branch is the only one that never reaches it. Test payments
		// corroborate nothing, and neither does a key nobody has connected.
		await clearEvidence(vendorId);
		await recordSuccess(vendorId, syncedAt);
		return {
			ok: true,
			matched: mapping.matched.length,
			unmatched: mapping.unmatched.length,
			testMode: true,
			truncated,
		};
	}

	// Replace rather than merge. A subscription that was cancelled since the
	// last sync must DISAPPEAR from evidence — merging would leave a stale row
	// asserting a customer still pays when they stopped, which is the worst
	// kind of wrong for a signed claim.
	await clearEvidence(vendorId);

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
		if (error) return recordFailure(vendorId, "Couldn't store payment evidence.");
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

	await recordSuccess(vendorId, syncedAt);

	return {
		ok: true,
		matched: mapping.matched.length,
		unmatched: mapping.unmatched.length,
		testMode: false,
		truncated,
	};
}

async function clearEvidence(vendorId: string): Promise<void> {
	const db = dbClient();
	if (!db) return;
	await db.from("vendor_payment_evidence").delete().eq("vendor_id", vendorId);
	await db.from("vendor_payment_unmatched").delete().eq("vendor_id", vendorId);
}

async function recordSuccess(vendorId: string, syncedAt: string): Promise<void> {
	const db = dbClient();
	if (!db) return;
	await db
		.from("vendor_stripe_credentials")
		.update({
			last_synced_at: syncedAt,
			last_sync_error: null,
			last_sync_failed_at: null,
			consecutive_sync_failures: 0,
		})
		.eq("vendor_id", vendorId);
}

/**
 * Record a failed sync, and delete the evidence once failures pile up.
 *
 * `last_synced_at` is deliberately NOT touched. It used to be stamped here,
 * which made the one column that could answer "how old is this evidence?" say
 * "just now" every hour a broken key failed.
 */
async function recordFailure(vendorId: string, error: string): Promise<SyncResult> {
	const db = dbClient();
	if (!db) return { ok: false, error };

	const { data } = await db
		.from("vendor_stripe_credentials")
		.select("consecutive_sync_failures")
		.eq("vendor_id", vendorId)
		.maybeSingle();

	const failures = (Number(data?.consecutive_sync_failures) || 0) + 1;
	await db
		.from("vendor_stripe_credentials")
		.update({
			last_sync_error: error,
			last_sync_failed_at: new Date().toISOString(),
			consecutive_sync_failures: failures,
		})
		.eq("vendor_id", vendorId);

	if (failures >= FAILURES_BEFORE_CLEARING) await clearEvidence(vendorId);

	return { ok: false, error };
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
	// Paged. A truncated set here does not fail loudly — it silently drops
	// domains, so a real customer's real payment gets rejected as
	// `no_observed_traffic` and their tier-3 evidence quietly disappears.
	try {
		const rows = await readAllRows<{ domain: string }>(`observed domains for ${vendorSlug}`, (from, to) =>
			db
				.from("hot_rollups")
				.select("domain")
				.eq("vendor_slug", vendorSlug)
				.gte("window_start", since)
				.order("window_start", { ascending: true })
				.order("domain", { ascending: true })
				.range(from, to),
		);
		return new Set(rows.map((r) => r.domain));
	} catch (e) {
		console.error("[letterprove:stripe-sync] observed-domain read failed", e instanceof Error ? e.message : String(e));
		// Empty set, which mapPayments treats as "nothing matches" — the safe
		// direction, and the behaviour this had before paging.
		return new Set();
	}
}
