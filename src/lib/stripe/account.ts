/**
 * Whose Stripe account is this?
 *
 * Tier 3 says "a third party's ledger shows this company paying THIS vendor".
 * Until this check, nothing tied the ledger to the vendor: a restricted key
 * from any Stripe account the vendor could get one for — a sister company's,
 * a friend's — corroborated their customers just the same. So on every connect
 * and every sync we read the account (GET /v1/account) and require one of the
 * domains it publishes about itself (business URL, support URL or email,
 * account email) to share the vendor's verified registrable domain.
 *
 * The honest exceptions — a parent company billing for a subsidiary on another
 * domain — go through a staff override bound to one account id. The vendor
 * cannot set it, and a key for a different account is checked afresh.
 */

import { dbClient } from "@/lib/db/client";
import { registrableDomain } from "@/lib/vendors/custom-domain";
import { fetchAccount, type StripeAccountIdentity } from "./fetch";

/** The permission, by Stripe's dashboard name and API name, that GET /v1/account needs. */
export const ACCOUNT_PERMISSION = "Accounts: Read (connected_account_read)";

export interface AccountOverride {
	accountId: string;
	at: string;
	by: string | null;
	reason: string | null;
}

export type AccountCheck =
	| { ok: true; account: StripeAccountIdentity; overridden: boolean }
	| {
			ok: false;
			error: "stripe_account_permission_missing" | "stripe_account_domain_mismatch" | "stripe_account_unreadable";
			detail: string;
			/** Present when the account was read but did not match, so it can be recorded and shown. */
			account?: StripeAccountIdentity;
	  };

/** Pure: does this account belong to this vendor, or has staff said it may? */
export function evaluateAccount(
	account: StripeAccountIdentity,
	vendorDomain: string,
	override: AccountOverride | null,
): AccountCheck {
	const vendorBase = registrableDomain(vendorDomain.toLowerCase());
	if (account.domains.some((d) => registrableDomain(d) === vendorBase)) {
		return { ok: true, account, overridden: false };
	}
	if (override && override.accountId === account.id) return { ok: true, account, overridden: true };

	const shown = account.domains.length > 0 ? account.domains.join(", ") : "no domain at all";
	return {
		ok: false,
		error: "stripe_account_domain_mismatch",
		detail: `This Stripe account (${account.id}) describes itself as ${shown}, not ${vendorBase}, the domain you verified. Payments only corroborate your customers when they come from your own Stripe account: set the account's business website or support email to your domain in Stripe, or contact support if your billing runs through a related company.`,
		account,
	};
}

/** Read the account behind a key and evaluate it against the vendor's row. */
export async function checkStripeAccount(apiKey: string, vendorId: string): Promise<AccountCheck> {
	const db = dbClient();
	if (!db) return { ok: false, error: "stripe_account_unreadable", detail: "Storage is unavailable." };

	const { data: vendor } = await db
		.from("vendors")
		.select("domain, stripe_account_override_account_id, stripe_account_override_at, stripe_account_override_by, stripe_account_override_reason")
		.eq("id", vendorId)
		.maybeSingle();
	if (!vendor?.domain) return { ok: false, error: "stripe_account_unreadable", detail: "Vendor not found." };

	const fetched = await fetchAccount(apiKey);
	if (!fetched.ok) {
		return fetched.scope
			? {
					ok: false,
					error: "stripe_account_permission_missing",
					detail: `Your Stripe restricted key cannot read which account it belongs to. Add ${ACCOUNT_PERMISSION} to the key in Stripe, alongside read access to Subscriptions and Invoices. Without it, payments cannot be tied to your business.`,
				}
			: { ok: false, error: "stripe_account_unreadable", detail: fetched.error };
	}

	return evaluateAccount(fetched.account, vendor.domain, overrideOf(vendor));
}

export function overrideOf(row: {
	stripe_account_override_account_id?: string | null;
	stripe_account_override_at?: string | null;
	stripe_account_override_by?: string | null;
	stripe_account_override_reason?: string | null;
}): AccountOverride | null {
	if (!row.stripe_account_override_account_id || !row.stripe_account_override_at) return null;
	return {
		accountId: row.stripe_account_override_account_id,
		at: row.stripe_account_override_at,
		by: row.stripe_account_override_by ?? null,
		reason: row.stripe_account_override_reason ?? null,
	};
}

/** Record what the account said, matched or not, so the vendor can see why. */
export async function recordAccount(vendorId: string, account: StripeAccountIdentity): Promise<void> {
	const db = dbClient();
	if (!db) return;
	await db
		.from("vendor_stripe_credentials")
		.update({ stripe_account_id: account.id, stripe_account_domains: account.domains, account_checked_at: new Date().toISOString() })
		.eq("vendor_id", vendorId);
}
