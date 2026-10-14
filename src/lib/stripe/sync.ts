/**
 * One vendor's Stripe sync: re-read which business the connected account is.
 *
 * Since 2026-10-14 Stripe is used ONLY to confirm the vendor is a real,
 * verified business at its domain (Casey's decision; README "Stripe"). No
 * subscriptions, invoices or products are read, and nothing about payments is
 * stored or published. What the sync keeps is the account's own statement
 * about itself, refreshed hourly because the key can be swapped for one from
 * another account at any time:
 *
 *   - whether Stripe lets the account accept payments (`charges_enabled`), which
 *     Stripe grants only after verifying the business;
 *   - the business name, country and website the account shows;
 *   - the domains it publishes, matched against the vendor's (account.ts).
 *
 * A failed read is counted, and after three in a row the recorded account is
 * cleared: a key the vendor can stop us from refreshing must not keep vouching
 * for them. `last_synced_at` means the last time a read actually succeeded.
 *
 * The payment tables (vendor_payment_evidence, vendor_payment_unmatched,
 * vendor_stripe_payers) are no longer written or read. Every sync deletes any
 * rows left in them, so nothing stale lingers before they are dropped.
 */

import { notifyVendor } from "@/lib/notify/vendor-email";
import { dbClient } from "@/lib/db/client";
import { checkStripeAccount, recordAccount } from "./account";
import { credentialFor } from "./credentials";

/**
 * Consecutive failed syncs before the recorded account is cleared. The cron
 * runs hourly, so this is three hours: long enough that a Stripe blip does not
 * wipe a vendor's verification, short enough that revoking the key is not a
 * way to keep it.
 */
const FAILURES_BEFORE_CLEARING = 3;

export type SyncResult =
	| {
			ok: true;
			/** Whether the account is the vendor's own (its domains match, or staff approved it). */
			bound: boolean;
			/** Whether Stripe has verified the business (the account can accept payments). */
			chargesEnabled: boolean;
			/** True for a test-mode key: it reads the account, but never verifies the business. */
			testMode: boolean;
			/** Kept for the cron's report shape; an account read is never truncated. */
			truncated: false;
			/** Set when the account was read but isn't the vendor's, so the vendor sees why. */
			warning?: string;
	  }
	| { ok: false; error: string };

export async function syncVendorStripe(vendorId: string, _vendorSlug?: string): Promise<SyncResult> {
	const db = dbClient();
	if (!db) return { ok: false, error: "No datastore configured." };

	const credential = await credentialFor(vendorId);
	if (!credential) return { ok: false, error: "No Stripe key connected." };

	const account = await checkStripeAccount(credential.key, vendorId);
	if (account.ok || account.account) await recordAccount(vendorId, account.ok ? account.account : account.account!);
	await clearRetiredPaymentRows(vendorId);

	if (!account.ok) {
		// Unreachable is an ordinary failure, counted toward the threshold. A
		// permission gap or a foreign account is a real answer: recorded (above)
		// and reported, and the attestation reads it as not bound.
		if (account.error === "stripe_account_unreadable") return recordFailure(vendorId, account.detail);
		await recordSuccess(vendorId, new Date().toISOString());
		return { ok: true, bound: false, chargesEnabled: false, testMode: !credential.livemode, truncated: false, warning: account.detail };
	}

	await recordSuccess(vendorId, new Date().toISOString());
	return {
		ok: true,
		bound: true,
		chargesEnabled: account.account.charges_enabled === true,
		testMode: !credential.livemode,
		truncated: false,
	};
}

/** The old name, kept so existing callers keep working. */
export const syncVendorPayments = syncVendorStripe;

/** Delete anything the retired payment sync left behind. */
async function clearRetiredPaymentRows(vendorId: string): Promise<void> {
	const db = dbClient();
	if (!db) return;
	await db.from("vendor_payment_evidence").delete().eq("vendor_id", vendorId);
	await db.from("vendor_payment_unmatched").delete().eq("vendor_id", vendorId);
	await db.from("vendor_stripe_payers").delete().eq("vendor_id", vendorId);
}

/** Forget what the account said, so a stale read never vouches for the vendor. */
async function clearRecordedAccount(vendorId: string): Promise<void> {
	const db = dbClient();
	if (!db) return;
	await db
		.from("vendor_stripe_credentials")
		.update({
			account_checked_at: null,
			stripe_charges_enabled: null,
			stripe_business_name: null,
			stripe_country: null,
			stripe_business_url_host: null,
		})
		.eq("vendor_id", vendorId);
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

/** Record a failed read, and clear the recorded account once failures pile up. */
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

	if (failures >= FAILURES_BEFORE_CLEARING) await clearRecordedAccount(vendorId);
	// Exactly at the threshold, so one failing streak is one email.
	if (failures === FAILURES_BEFORE_CLEARING) await notifyVendor(vendorId, "stripe_failing", `streak@${new Date().toISOString()}`, { detail: error });

	return { ok: false, error };
}
