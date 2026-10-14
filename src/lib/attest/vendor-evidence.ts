/**
 * The reads behind the vendor attestation that are not telemetry: who the
 * vendor is (hosts, the Stripe-verified business) and first observation.
 *
 * Every function here fails toward the weaker claim. A read that errors
 * returns the answer that says less — no binding, no verified business, no
 * date — never a guess, because whatever it returns is signed.
 *
 * Nothing here names a customer, and nothing reads payments: since 2026-10-14
 * Stripe only confirms the vendor is a real, verified business at its domain.
 */

import { dbClient } from "@/lib/db/client";
import { readAllRows } from "@/lib/db/read-all";
import { evaluateAccount, overrideOf } from "@/lib/stripe/account";
import { acceptedHosts } from "@/lib/vendors/hosts";
import { registrableDomain } from "@/lib/vendors/custom-domain";

/** An account read older than this reads as absent: the sync runs hourly, so a day is many missed runs. */
const MAX_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

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

/**
 * The business behind the vendor's connected Stripe account, as Stripe states
 * it. Signed into the attestation as `stripe_business`.
 */
export interface StripeBusiness {
	/**
	 * Stripe has verified the business: the account can accept payments
	 * (`charges_enabled`), which Stripe allows only after checking the legal
	 * entity, the people behind it and a bank account. False for a test-mode key,
	 * which can read the account but proves nothing about it.
	 */
	verified: boolean;
	/** The business name the account shows. */
	name: string | null;
	/** Two-letter country of the account. */
	country: string | null;
	/** Host of the business website on the account. */
	website: string | null;
	/** Whether that website shares the vendor's registrable domain. */
	website_matches_domain: boolean;
	/** How the account was tied to the vendor: its published domains match, or staff approved it. */
	binding: StripeBinding;
}

/**
 * What the vendor's own Stripe account says about the business. Null when
 * Stripe isn't connected, the account was never read (or not in the last day),
 * or the account isn't the vendor's. Reads nothing about payments.
 */
export async function stripeBusiness(vendorId: string, vendorDomain: string): Promise<StripeBusiness | null> {
	const db = dbClient();
	if (!db) return null;
	const binding = await stripeBinding(vendorId, vendorDomain);
	if (!binding) return null;
	const { data, error } = await db
		.from("vendor_stripe_credentials")
		.select("livemode, account_checked_at, stripe_charges_enabled, stripe_business_name, stripe_country, stripe_business_url_host")
		.eq("vendor_id", vendorId)
		.maybeSingle();
	if (error || !data?.account_checked_at) return null;
	if (Date.now() - Date.parse(data.account_checked_at as string) > MAX_ACCOUNT_AGE_MS) return null;
	const website = (data.stripe_business_url_host as string | null) ?? null;
	return {
		verified: data.livemode === true && data.stripe_charges_enabled === true,
		name: (data.stripe_business_name as string | null) ?? null,
		country: (data.stripe_country as string | null) ?? null,
		website,
		website_matches_domain: Boolean(website) && registrableDomain(website!) === registrableDomain(vendorDomain.toLowerCase()),
		binding,
	};
}

/**
 * Whether the Stripe evidence reaches tier 3: Stripe verified the business,
 * and either its website is on the vendor's domain or staff approved the
 * account (a parent company billing for a subsidiary). Pure.
 */
export function stripeBusinessConfirms(business: StripeBusiness | null): boolean {
	if (!business?.verified) return false;
	return business.website_matches_domain || business.binding === "staff_override";
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

/** Older PostHog history reads as absent: the sync runs daily, so two days is one missed run. */
export const MAX_HISTORY_AGE_MS = 48 * 60 * 60 * 1000;

export interface ReportedHistory {
	/** Where the history came from. Only PostHog today. */
	source: "posthog";
	/** Company domains the vendor's PostHog has identified people from. */
	companies: number;
	/** When PostHog first saw a person from any of them, ISO. */
	since: string | null;
	/** Of those, how many had activity in PostHog in the last 30 days. */
	active_companies_30d: number;
	/** Of the companies Letterprove observed this window, how many PostHog also knows. */
	observed_also_reported: number;
}

/**
 * The vendor's own analytics history, as counts. VENDOR-REPORTED: the vendor
 * controls its PostHog project, so this is published under `vendor_stated`
 * and never moves the tier. Null unless PostHog is connected, synced in the
 * last two days, and the project sees the vendor's own hosts.
 *
 * `observed_also_reported` is the one figure here that is not purely the
 * vendor's word: it is how far their history agrees with what Letterprove
 * observed itself.
 */
export async function reportedHistory(vendorId: string, observed: readonly string[]): Promise<ReportedHistory | null> {
	const db = dbClient();
	if (!db) return null;
	const { data: cred, error: credError } = await db
		.from("vendor_posthog_credentials")
		.select("last_synced_at, host_events_30d")
		.eq("vendor_id", vendorId)
		.maybeSingle();
	if (credError || !cred?.last_synced_at || !(Number(cred.host_events_30d) > 0)) return null;
	if (Date.now() - Date.parse(cred.last_synced_at as string) > MAX_HISTORY_AGE_MS) return null;

	let rows: { domain: string; first_seen: string | null; active_people_30d: number }[];
	try {
		rows = await readAllRows(`posthog history for ${vendorId}`, (from, to) =>
			db
				.from("vendor_posthog_domains")
				.select("domain, first_seen, active_people_30d")
				.eq("vendor_id", vendorId)
				.order("domain", { ascending: true })
				.range(from, to),
		);
	} catch {
		return null;
	}
	if (rows.length === 0) return null;

	const wanted = new Set(observed);
	const since = rows
		.map((r) => (r.first_seen ? Date.parse(r.first_seen) : NaN))
		.filter((t) => Number.isFinite(t))
		.sort((a, b) => a - b)[0];
	return {
		source: "posthog",
		companies: rows.length,
		since: since ? new Date(since).toISOString() : null,
		active_companies_30d: rows.filter((r) => Number(r.active_people_30d) > 0).length,
		observed_also_reported: rows.filter((r) => wanted.has(r.domain)).length,
	};
}
