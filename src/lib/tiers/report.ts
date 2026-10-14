/**
 * Why is everything tier 0?
 *
 * That question currently takes a Supabase query, a fixture read and a mental
 * join to answer, which means it gets answered by hand or not at all. This
 * turns it into a function.
 *
 * For one vendor it lines up what was observed (`hot_rollups`), which of those
 * domains pay through the vendor's own Stripe account (payment evidence), and
 * the vendor's private customer list, and states per domain how it counts in
 * the vendor attestation.
 *
 * It reports; it publishes nothing. The vendor attestation publishes counts
 * only (README decision 30); this is the per-domain view behind them, and it
 * deliberately exposes customer domains — **this output is for the vendor
 * itself (list_observed) and staff (tier_report), and must never be served
 * unauthenticated.**
 */

import { classifyDomain, type DomainKind } from "@/lib/identity/domains";
import { earned } from "@/lib/attest/body";
import { allVendors, type CustomerFixture } from "@/lib/fixtures/vendors";
import { readAllRows } from "@/lib/db/read-all";
import { dbClient } from "@/lib/db/client";
import type { Tier } from "@/lib/attest/types";

/** Matches the publishing window in rollup/snapshots.ts. */
const WINDOW_DAYS = 30;

/**
 * How a domain counts in the vendor attestation. The first that applies wins.
 */
export type TierStatus =
	/** Observed, but the domain can never name a company: excluded, counted in `domains_excluded`. */
	| "not-attributable"
	/** On the vendor's private list, but nothing observed in the window: not counted. */
	| "no-observation"
	/** An observed company: counted in `companies_observed`. */
	| "observed"
	/** An observed company with a settled, in-scope invoice: also counted in `paying_companies`. */
	| "paying";

export interface DomainTierRow {
	domain: string;
	kind: DomainKind;
	sessions: number;
	signups: number;
	logins: number;
	/** The vendor's private customer record for this domain, when one exists. Never published. */
	customer: string | null;
	/** What the evidence supports for this domain right now. Null when it can't name a company. */
	earnedTier: Tier | null;
	status: TierStatus;
	/** Written to be read by a person deciding what to do next. */
	detail: string;
}

export interface VendorTierReport {
	vendor: string;
	/** Distinct domains seen in the window, whatever their kind. */
	observed: number;
	/** Of those, how many could ever name a company. */
	attributable: number;
	/** Observed companies without payment evidence: counted, but not corroborated by Stripe. */
	unpublishedEvidence: number;
	/** Observed companies counted in the vendor attestation (`companies_observed`). */
	published: number;
	/** Of those, how many pay through the vendor's own Stripe account (`paying_companies`). */
	paying: number;
	rows: DomainTierRow[];
}

interface RollupTotals {
	sessions: number;
	signups: number;
	logins: number;
}

/** Every domain this vendor has been observed for, in the publishing window. */
async function observedTotals(vendorSlug: string): Promise<Map<string, RollupTotals> | null> {
	const db = dbClient();
	if (!db) return null;

	const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
	// Paged: these totals are summed into a SIGNED document, so a silently
	// truncated read publishes a claim that understates its own evidence.
	// Ordered because paging an unordered query can repeat or skip rows.
	let data: { domain: string; sessions: number; signups: number; logins: number }[];
	try {
		data = await readAllRows(`rollups for ${vendorSlug}`, (from, to) =>
			db
				.from("hot_rollups")
				.select("domain, sessions, signups, logins")
				.eq("vendor_slug", vendorSlug)
				.gte("window_start", since)
				.order("window_start", { ascending: true })
				.order("domain", { ascending: true })
				.range(from, to),
		);
	} catch (e) {
		// null, never an empty map: callers treat null as "couldn't read" and
		// report unavailable, where an empty map would claim the vendor has been
		// observed serving nobody.
		console.error("[letterprove:tiers] rollup query failed", e instanceof Error ? e.message : String(e));
		return null;
	}

	const totals = new Map<string, RollupTotals>();
	for (const row of data as (RollupTotals & { domain: string })[]) {
		const prev = totals.get(row.domain) ?? { sessions: 0, signups: 0, logins: 0 };
		totals.set(row.domain, {
			sessions: prev.sessions + row.sessions,
			signups: prev.signups + row.signups,
			logins: prev.logins + row.logins,
		});
	}
	return totals;
}

/**
 * The whole decision, as a pure function, exported so every branch is tested.
 */
export function classifyRow(
	domain: string,
	totals: RollupTotals,
	customer: CustomerFixture | undefined,
	/**
	 * The vendor's DNS-verified state. The same gate the attestation applies,
	 * so this never reports a tier the proof will not carry.
	 */
	domainVerified: boolean,
	vendorDomain?: string,
	/** Whether this domain has fresh payment evidence from the vendor's own Stripe account. */
	paid = false,
): DomainTierRow {
	const { kind } = classifyDomain(domain, vendorDomain);
	const observed = totals.sessions + totals.signups + totals.logins > 0;
	const payment = paid ? { currency: "", monthlyAmount: 1, since: "", subscriptionCount: 1 } : null;

	const base = {
		domain,
		kind,
		...totals,
		customer: customer?.slug ?? null,
		earnedTier: kind === "company" ? earned(observed, domainVerified, payment).tier : null,
	};

	if (kind !== "company") {
		return { ...base, status: "not-attributable", detail: `${kind}: counted as excluded, never as a company` };
	}
	if (!observed) {
		return { ...base, status: "no-observation", detail: "on your list, but nothing observed in the last 30 days" };
	}
	if (base.earnedTier === 3) {
		return { ...base, status: "paying", detail: "observed and paying through your Stripe account: counted in paying_companies" };
	}
	return {
		...base,
		status: "observed",
		detail: domainVerified
			? "observed: counted in companies_observed"
			: "observed, but your domain isn't proven by DNS, so nothing counts yet",
	};
}

/**
 * Returns null for an unknown vendor, and for a vendor whose telemetry could
 * not be read — a report that silently showed every domain as unobserved
 * because a query failed would be worse than no report, since "no evidence"
 * is exactly the conclusion someone would act on.
 */
export async function tierReport(vendorSlug: string): Promise<VendorTierReport | null> {
	const vendors = await allVendors();
	const vendor = vendors.find((v) => v.slug === vendorSlug);
	if (!vendor) return null;

	const totals = await observedTotals(vendor.slug);
	if (!totals) return null;
	// Payments are no longer read (2026-10-14): nobody is "paying".
	const paid = new Set<string>();

	const byDomain = new Map<string, CustomerFixture>();
	for (const c of vendor.customers) byDomain.set(c.domain, c);

	const domains = new Set<string>([...totals.keys(), ...byDomain.keys()]);

	const rows = [...domains]
		.map((d) =>
			classifyRow(
				d,
				totals.get(d) ?? { sessions: 0, signups: 0, logins: 0 },
				byDomain.get(d),
				vendor.domainVerified,
				vendor.domain,
				paid.has(d),
			),
		)
		.sort((a, b) => b.sessions - a.sessions || a.domain.localeCompare(b.domain));

	const counted = rows.filter((r) => (r.status === "observed" || r.status === "paying") && vendor.domainVerified);
	return {
		vendor: vendor.slug,
		observed: [...totals.keys()].length,
		attributable: rows.filter((r) => r.kind === "company" && totals.has(r.domain)).length,
		unpublishedEvidence: counted.filter((r) => r.status === "observed").length,
		published: counted.length,
		paying: counted.filter((r) => r.status === "paying").length,
		rows,
	};
}
