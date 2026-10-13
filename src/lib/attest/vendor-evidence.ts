/**
 * The reads behind the vendor attestation that are not telemetry: who the
 * vendor is (hosts, Stripe binding) and what corroborates it (payment
 * evidence, first observation).
 *
 * Every function here fails toward the weaker claim. A read that errors
 * returns the answer that says less — no binding, no paying companies, no
 * date — never a guess, because whatever it returns is signed.
 *
 * Nothing here names a customer. Payment evidence is keyed by customer domain
 * internally; what leaves this module is a count and a date.
 */

import { dbClient } from "@/lib/db/client";
import { evaluateAccount, overrideOf } from "@/lib/stripe/account";
import { acceptedHosts } from "@/lib/vendors/hosts";

/** Matches MAX_EVIDENCE_AGE_MS in ./payment-evidence.ts: older evidence reads as absent. */
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

export type StripeBinding = "domain_match" | "staff_override";

/**
 * Whether the vendor's connected Stripe account is theirs, as last read by the
 * Stripe sync (src/lib/stripe/account.ts records what the account says about
 * itself on every connect and sync).
 *
 * `domain_match` when a domain the account publishes shares the vendor's
 * verified registrable domain; `staff_override` when staff approved this exact
 * account; null when Stripe isn't connected, the account was never read, or it
 * doesn't match.
 */
export async function stripeBinding(vendorId: string, vendorDomain: string): Promise<StripeBinding | null> {
	const db = dbClient();
	if (!db) return null;
	const [{ data: cred, error: credError }, { data: vendor, error: vendorError }] = await Promise.all([
		db
			.from("vendor_stripe_credentials")
			.select("stripe_account_id, stripe_account_domains, account_checked_at")
			.eq("vendor_id", vendorId)
			.maybeSingle(),
		db
			.from("vendors")
			.select(
				"stripe_account_override_account_id, stripe_account_override_at, stripe_account_override_by, stripe_account_override_reason",
			)
			.eq("id", vendorId)
			.maybeSingle(),
	]);
	if (credError || vendorError || !cred?.stripe_account_id || !cred.account_checked_at) return null;

	const account = {
		id: cred.stripe_account_id as string,
		domains: Array.isArray(cred.stripe_account_domains) ? (cred.stripe_account_domains as string[]) : [],
	};
	const check = evaluateAccount(account, vendorDomain, vendor ? overrideOf(vendor) : null);
	if (!check.ok) return null;
	return check.overridden ? "staff_override" : "domain_match";
}

/** How many extra hosts the collector accepts for this vendor. A count, never the hosts. */
export async function hostCount(vendorId: string): Promise<number> {
	return (await acceptedHosts(vendorId)).size;
}

export interface Paying {
	/** Observed company domains with fresh, settled payment evidence. */
	companies: number;
	/** Earliest settled invoice among them, ISO. Null when none. */
	since: string | null;
}

/**
 * How many of the given observed company domains currently carry payment
 * evidence. Only domains in `observed` count: payment without observed use is
 * not evidence that anyone uses the product, and this system only claims what
 * it observed.
 */
export async function payingAmong(vendorId: string, observed: readonly string[]): Promise<Paying> {
	const none: Paying = { companies: 0, since: null };
	if (observed.length === 0) return none;
	const db = dbClient();
	if (!db) return none;

	const floor = new Date(Date.now() - MAX_EVIDENCE_AGE_MS).toISOString();
	const { data, error } = await db
		.from("vendor_payment_evidence")
		.select("domain, since, monthly_amount")
		.eq("vendor_id", vendorId)
		.gte("synced_at", floor);
	if (error || !data) return none;

	const wanted = new Set(observed);
	const rows = (data as { domain: string; since: string | null; monthly_amount: number | string }[]).filter(
		(r) => wanted.has(r.domain) && Number(r.monthly_amount) >= 1,
	);
	if (rows.length === 0) return none;
	const since = rows
		.map((r) => (typeof r.since === "string" ? Date.parse(r.since) : NaN))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b)[0];
	return { companies: rows.length, since: since ? new Date(since).toISOString() : null };
}

/**
 * When Letterprove first published observed usage for this vendor: the oldest
 * frozen vendor attestation that counted at least one company. Our own signed
 * record, not the vendor's claim, and it includes the weeks a vendor spends
 * private before publishing (the freeze runs either way). Null when there is
 * none yet or the read failed.
 */
export async function observedSince(vendorSlug: string): Promise<string | null> {
	const db = dbClient();
	if (!db) return null;
	const { data, error } = await db
		.from("published_aggregates")
		.select("published_at")
		.eq("vendor_slug", vendorSlug)
		.gt("attestation->companies_observed", 0)
		.order("hour_bucket", { ascending: true })
		.limit(1)
		.maybeSingle();
	if (error || !data?.published_at) return null;
	return new Date(data.published_at as string).toISOString();
}
