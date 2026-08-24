/**
 * Why is everything tier 0?
 *
 * That question currently takes a Supabase query, a fixture read and a mental
 * join to answer, which means it gets answered by hand or not at all. This
 * turns it into a function.
 *
 * For one vendor it lines up three things that normally live apart — what was
 * observed (`hot_rollups`), who the vendor claims as a customer (the customer
 * records), and what the evidence gate will actually publish — and states, per
 * domain, the single reason that domain is or isn't a published claim.
 *
 * It reports; it publishes nothing. Every value here is derived from data that
 * already exists, and nothing it returns is signed or reaches an attestation.
 * That matters because it deliberately exposes customer domains, including
 * withheld and unattributable ones — **this output is staff-only and must
 * never be served unauthenticated.**
 */

import { classifyDomain, type DomainKind } from "@/lib/identity/domains";
import { earned } from "@/lib/attest/body";
import { allVendors, consentOf, type Consent, type CustomerFixture } from "@/lib/fixtures/vendors";
import { dbClient } from "@/lib/db/client";
import type { Tier } from "@/lib/attest/types";

/** Matches the publishing window in rollup/snapshots.ts. */
const WINDOW_DAYS = 30;

/**
 * The single reason a domain is, or is not, a published claim. Ordered from
 * "nothing to say" to "actually published" — the first one that applies wins,
 * because a domain blocked for two reasons is only actionable on the first.
 */
export type TierStatus =
	/** Observed, but the domain can never name a company. */
	| "not-attributable"
	/** Attributable and observed — nobody has created a customer record. */
	| "no-customer-record"
	/** Record exists, but consent to be named has not been given. */
	| "consent-withheld"
	/** Record exists and is publishable, but nothing was observed to earn a tier. */
	| "no-observation"
	/** Published, at the tier the evidence earned. */
	| "published";

export interface DomainTierRow {
	domain: string;
	kind: DomainKind;
	sessions: number;
	signups: number;
	logins: number;
	/** The customer record this domain maps to, when one exists. */
	customer: string | null;
	/** What the vendor claims. A ceiling, never a floor — see body.ts's earned(). */
	assertedTier: Tier | null;
	/** What the evidence actually supports right now. */
	earnedTier: Tier | null;
	consent: Consent | null;
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
	/** Attributable, observed, and not published — the actionable backlog. */
	unpublishedEvidence: number;
	/** Customer records that are actually publishing a claim today. */
	published: number;
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
	const { data, error } = await db
		.from("hot_rollups")
		.select("domain, sessions, signups, logins")
		.eq("vendor_slug", vendorSlug)
		.gte("window_start", since);

	if (error) {
		console.error("[letterprove:tiers] rollup query failed", error.message);
		return null;
	}

	const totals = new Map<string, RollupTotals>();
	for (const row of (data ?? []) as (RollupTotals & { domain: string })[]) {
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
 * The whole decision, as a pure function.
 *
 * Exported because this is the part worth testing exhaustively: the fixture
 * vendors can't exercise every branch (vantage's `.example` domains are
 * reserved-TLD by design, so they never reach the consent or observation
 * checks), and a status this report gets wrong sends someone to fix the wrong
 * thing.
 */
export function classifyRow(
	domain: string,
	totals: RollupTotals,
	customer: CustomerFixture | undefined,
	/**
	 * The vendor's DNS-verified state. This report exists to tell an operator
	 * why a customer isn't earning what it asserts, so it has to apply the
	 * same gate publishing does — otherwise it would report an earned tier
	 * the proof will never actually carry.
	 */
	domainVerified: boolean,
	vendorDomain?: string,
): DomainTierRow {
	const { kind } = classifyDomain(domain, vendorDomain);
	const observed = totals.sessions + totals.signups + totals.logins > 0;

	const base = {
		domain,
		kind,
		...totals,
		customer: customer?.slug ?? null,
		assertedTier: customer?.tier ?? null,
		earnedTier: customer ? earned(customer, observed, domainVerified).tier : null,
		consent: customer ? consentOf(customer) : null,
	};

	// Order matters: an unattributable domain with a record is still
	// unattributable, and that is the thing to fix first.
	if (kind !== "company") {
		return {
			...base,
			status: "not-attributable",
			detail: `${kind} — counted, never publishable as a customer`,
		};
	}
	if (!customer) {
		return {
			...base,
			status: "no-customer-record",
			detail: "observed and attributable — no customer record exists yet",
		};
	}
	if (consentOf(customer) !== "named") {
		return {
			...base,
			status: "consent-withheld",
			detail: "record exists; contributes to the aggregate but is not named",
		};
	}
	if (!observed) {
		return { ...base, status: "no-observation", detail: "named, but nothing observed to earn a tier" };
	}
	return {
		...base,
		status: "published",
		detail: `published at tier ${base.earnedTier}${
			base.earnedTier !== base.assertedTier ? ` (asserted ${base.assertedTier}, capped by evidence)` : ""
		}`,
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

	const byDomain = new Map<string, CustomerFixture>();
	for (const c of vendor.customers) byDomain.set(c.domain, c);

	// Union of what was observed and who is on record: a customer with no
	// traffic is as much a finding as traffic with no customer.
	const domains = new Set<string>([...totals.keys(), ...byDomain.keys()]);

	const rows = [...domains]
		.map((d) =>
			classifyRow(
				d,
				totals.get(d) ?? { sessions: 0, signups: 0, logins: 0 },
				byDomain.get(d),
				vendor.domainVerified,
				vendor.domain,
			),
		)
		.sort((a, b) => b.sessions - a.sessions || a.domain.localeCompare(b.domain));

	return {
		vendor: vendor.slug,
		observed: [...totals.keys()].length,
		attributable: rows.filter((r) => r.kind === "company" && totals.has(r.domain)).length,
		unpublishedEvidence: rows.filter(
			(r) => r.status === "no-customer-record" || r.status === "consent-withheld"
		).length,
		published: rows.filter((r) => r.status === "published").length,
		rows,
	};
}
