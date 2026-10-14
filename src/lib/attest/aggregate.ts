/**
 * The vendor attestation — the one public claim Letterprove makes.
 *
 * It says two things about a vendor and nothing about anyone else:
 *
 *   1. WHO THEY ARE. The domain they proved (by DNS, re-checked daily, or by
 *      site proof), since when, how many extra hosts the collector accepts,
 *      and the business Stripe has verified behind their own Stripe account
 *      (`stripe_business`: verified, name, country, website, and whether that
 *      website is on their domain). Stripe is used for nothing else: since
 *      2026-10-14 no payment is read or published.
 *   2. WHAT BACKS IT. How many companies were observed signing in over the
 *      last 30 days and how many sessions — counts, never names.
 *
 * NO CUSTOMER IS EVER NAMED, except on the vendor's opt-in logo wall (README
 * decision 36), and only companies already on that public page. Per-customer
 * documents were retired on 2026-10-13 (README decision 30).
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. Not "customers" — "companies observed".
 * A session from `someone@acme.com` proves a person at Acme used the product;
 * it does not prove Acme buys it, and nothing here claims it does.
 *
 * Unattributable domains are counted and excluded, never silently dropped:
 * `domains_excluded` is published alongside so the headline can be read
 * honestly. Free-mail is a person, our own domains are us, and neither is a
 * company — see lib/identity/domains.ts.
 *
 * CHAINED AND FROZEN. rollup/freeze-aggregates.ts persists one signed entry
 * per vendor per hour, rollup/aggregate-history.ts reads that history back, and
 * `/attest/{vendor}/chain` publishes it. What `vendorAggregateChain` serves is
 * exactly the frozen rows and nothing signed on the side (see buildChainFor),
 * so every document handed out is stored and its `verify` link resolves.
 *
 * A frozen entry is permanent, so a wrong one is permanent. That is why the
 * freeze refuses a development-key signature and refuses a body built on a
 * failed telemetry read, rather than persisting a signed zero.
 */

import { canonicalBytes } from "./canonical";
import { fraudFeatures } from "./fraud-features";
import { createHourlyMemo } from "./hourly-memo";
import { isDemonstration } from "./keys";
import { methodUrl } from "./method";
import { signAttestation } from "./sign";
import { GENESIS_HASH, snapshotHash } from "./verify";
import { partitionDomains } from "@/lib/identity/domains";
import { findPublishedVendor, findVendor } from "@/lib/fixtures/vendors";
import { readAllRows } from "@/lib/db/read-all";
import { dbClient } from "@/lib/db/client";
import { loadAggregateHistory } from "@/rollup/aggregate-history";
import type { PaymentScope, Tier } from "./types";
import { nextSnapshotAt, SNAPSHOT_CADENCE_SECONDS } from "./cadence";
import { verifyLink } from "./verify-link";
import { DEFAULT_DISPLAY, displayFor, hiddenSections, type DisplaySection, type DisplaySettings } from "./display";
import { growthFor, markPartialMonths, retentionFor, type GrowthPoint, type Retention } from "./growth";
import { withDisclosure } from "./issuer";
import { publicLogos, readLogoWall, type PublicLogos } from "@/lib/vendors/logo-wall";
import {
	hostCount,
	observedSince,
	reportedHistory,
	stripeBusiness,
	stripeBusinessConfirms,
	type ReportedHistory,
	type StripeBinding,
	type StripeBusiness,
} from "./vendor-evidence";

import { domainProofOf, tierForProof, type DomainProof } from "./domain-proof";

const METHOD_PATH = "src/lib/attest/aggregate.ts";
const WINDOW_DAYS = 30;

export interface AggregateBody {
	vendor: string;
	/** The only kind published since 2026-10-13. Older chains also hold retired per-customer documents. */
	kind: "aggregate";
	/**
	 * The domain the vendor proved by DNS. Absent before 2026-10-13, like every
	 * identity field below.
	 */
	domain?: string;
	/** When DNS control was last proven (re-checked daily), or null when it isn't proven. */
	domain_verified_since?: string | null;
	/**
	 * How the vendor's claim to `domain` is proven (lib/attest/domain-proof.ts):
	 * `dns` (TXT record), `site` (attest.js with the vendor's key found on a page
	 * of the domain; weaker, tier 1 at most) or `none` (the vendor's claim; tier
	 * 0). Since 2026-10-14, when DNS became optional. Absent on older documents,
	 * which could only be published with DNS proof.
	 */
	domain_proof?: DomainProof;
	/**
	 * True only for `domain_proof: "dns"`. Kept as a boolean for readers that
	 * only ask "is the domain DNS-proven"; site proof is NOT domain verification.
	 * Absent on documents signed before 2026-10-14.
	 */
	domain_verified?: boolean;
	/**
	 * How many extra hosts the vendor added for the collector to accept. A
	 * count, never the hosts. Hosts beneath the verified domain are covered by
	 * its DNS proof and accepted without being added (since 2026-10-13), so they
	 * are not counted here unless the vendor added them explicitly.
	 */
	hosts?: number;
	/** Whether the connected Stripe account is the vendor's own. Present only when Stripe is connected and shown. */
	stripe_account_bound?: boolean;
	/** How that was established: its published domains match, or staff approved it. Present only with stripe_account_bound. */
	stripe_binding?: StripeBinding | null;
	/**
	 * The business behind the vendor's own Stripe account, as Stripe states it:
	 * `verified` (Stripe lets the account accept payments, which it allows only
	 * after verifying the business), name, country, website, and whether that
	 * website is on the vendor's domain. Identity only: no payment is read.
	 * Absent when Stripe isn't connected or the account isn't the vendor's.
	 * Since 2026-10-14.
	 */
	stripe_business?: StripeBusiness;
	/**
	 * RETIRED 2026-10-13 (README decision 35): no longer published. Snapshots
	 * signed between #182 and that change carry it; they still verify. The
	 * count stays private to the vendor; tier 3 says payment is corroborated.
	 */
	paying_companies?: number;
	/** RETIRED 2026-10-14 (payments are no longer read). Older documents carry it. */
	paying_since?: string | null;
	/** When Letterprove first observed usage for this vendor, from its own frozen record. */
	observed_since?: string | null;
	window_days: number;
	/** Distinct company domains observed. NOT a customer count — see module doc. */
	companies_observed: number;
	/** Absent when the vendor hides session counts. */
	sessions?: number;
	signups?: number;
	logins?: number;
	/** Observed domains that can never name a company: free-mail, internal, malformed. */
	domains_excluded: number;
	tier: Tier;
	/**
	 * Fields that are the vendor's statement rather than evidence. Empty unless
	 * `reported_history` is present — every other figure is counted from
	 * observed events — and published anyway so the absence is stated, not
	 * inferred. Absent before 2026-10-13.
	 */
	vendor_stated?: string[];
	/**
	 * VENDOR-REPORTED. Company history from the vendor's own PostHog project,
	 * as counts: how many companies it has identified people from, since when,
	 * how many were active in the last 30 days, and how many of
	 * `companies_observed` it also knows. Listed in `vendor_stated` and never
	 * moves the tier: the vendor controls that project. Present only while
	 * PostHog is connected, fresh, and sees the vendor's own hosts. Absent
	 * before 2026-10-13.
	 */
	reported_history?: ReportedHistory;
	/**
	 * Logo verification (README decision 36), opt-in. The companies the vendor
	 * already shows on its own public logo wall (`page`) that Letterprove
	 * observed signing in over the window ("active"), or that also paid a
	 * settled invoice in the bound Stripe account ("paying"). ONLY those are
	 * named; `listed` and `on_page` count everything the vendor declared and
	 * everything found on the page. Never moves the tier. Absent unless
	 * configured, checked within two days, and the domain is verified. Absent
	 * before 2026-10-13.
	 */
	logos?: PublicLogos;
	/** RETIRED 2026-10-14 (payments are no longer read). Older documents carry it. */
	paying?: { scope: "signed_in" | "all"; companies: number };
	/** RETIRED 2026-10-14 (payments are no longer read). Older documents carry it. */
	payment_scope?: PaymentScope;
	/**
	 * RETIRED 2026-10-14: a proof says nothing about what the vendor chose not
	 * to show, so a hidden section and a missing one now look the same (absent).
	 * Older documents carry these; the verifier still accepts them.
	 */
	hidden_by_vendor?: string[];
	/** RETIRED 2026-10-14, see hidden_by_vendor. Older documents carry it. */
	omitted?: Record<string, OmitReason>;
	/**
	 * Companies observed per calendar month (UTC), oldest first, up to six
	 * months: the highest companies_observed any frozen snapshot carried that
	 * month. From Letterprove's own signed history. `partial: true` marks a
	 * month with no full 30-day window of observation behind it (since
	 * 2026-10-14). Absent with under two months of history. Absent before
	 * 2026-10-13.
	 */
	growth?: GrowthPoint[];
	/**
	 * Of the company domains observed from 90 to 60 days ago (`cohort`), how
	 * many were also observed in the last 30 days (`retained`). Counts only. Absent when the cohort is under 10. Absent
	 * before 2026-10-13.
	 */
	retention?: Retention;
	observed_through: string;
	published_at: string;
	/** When a newer snapshot is due. Absent on snapshots signed before 2026-10-08 — see ./cadence.ts. */
	next_snapshot_at?: string;
	/** Legacy: the cache hint those earlier snapshots carry instead. Never written now. */
	ttl?: number;
	/** This snapshot's own plain-language check. Absent before 2026-10-08 — see ./verify-link.ts. */
	verify?: string;
	/** Signed disclosure when the vendor shares an owner with Letterprove — see ./issuer.ts. */
	issuer_affiliation?: string;
	prev_hash: string;
	method: string;
}

export type SignedAggregate = AggregateBody & { key_id: string; signature: string };

export type OmitReason = "hidden" | "insufficient_history" | "not_connected" | "not_configured" | "domain_not_verified";

interface Totals {
	sessions: number;
	signups: number;
	logins: number;
}

/**
 * What the evidence supports for the vendor claim: the strongest evidence
 * class present (see domain-proof.ts tierForProof).
 *
 *   3 — companies observed on a DNS-proven domain, and Stripe has verified
 *       the business behind the vendor's own Stripe account at that domain;
 *   1 — companies observed on a verified domain;
 *   0 — nothing observed, or the domain isn't proven.
 *
 * Tier 1, not 2. This used to claim tier 2 on the strength of two
 * infrastructure facts (our receipt timestamp and the pinned origin, decision
 * 14). Those are exactly what tier 1 already is — the per-customer path
 * published the same evidence as tier 1 — and tier 2 is now reserved for the
 * ASN binding that is not built (decision 29). One evidence class, one tier.
 *
 * Gated on DNS proof, like earned(). An observation pinned to a domain nobody
 * has proven, or no longer proves (the daily re-check clears
 * `domain_verified_at` when the TXT record is gone), is the vendor asserting.
 * Capped at 0 with nothing observed: a tier is a statement about evidence,
 * and there isn't any.
 */
export function earnedAggregateTier(observed: boolean, domainVerified: boolean, stripeBusinessConfirmed = false): Tier {
	return tierForProof(observed, domainVerified ? "dns" : "none", stripeBusinessConfirmed);
}

/** Every domain this vendor was observed for in the window, with its totals. */
async function observedTotals(vendorSlug: string): Promise<Map<string, Totals> | null> {
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
		// null, never an empty map. aggregateBody turns null into "publish
		// nothing"; an empty map would publish a confident zero, which is a
		// false signed claim rather than a missing one.
		console.error("[letterprove:aggregate] rollup query failed", e instanceof Error ? e.message : String(e));
		return null;
	}

	const totals = new Map<string, Totals>();
	for (const row of data as (Totals & { domain: string })[]) {
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
 * Returns null for an unknown vendor, and for one whose telemetry could not be
 * read. A failed read must never publish as "0 companies observed" — that is a
 * false claim signed and served, not a missing one.
 */
export async function aggregateBody(vendorSlug: string): Promise<Omit<AggregateBody, "prev_hash"> | null> {
	const vendor = await findVendor(vendorSlug);
	if (!vendor) return null;

	const totals = await observedTotals(vendor.slug);
	if (!totals) return null;

	const { attributable, excluded } = partitionDomains(totals.keys(), vendor.domain);
	const summed = attributable.reduce<Totals>(
		(acc, d) => {
			const t = totals.get(d)!;
			return {
				sessions: acc.sessions + t.sessions,
				signups: acc.signups + t.signups,
				logins: acc.logins + t.logins,
			};
		},
		{ sessions: 0, signups: 0, logins: 0 }
	);

	const proof = domainProofOf(vendor);
	const [business, hosts, firstObserved, history] = await Promise.all([
		// Stripe's statement about the business stands on its own (the account
		// must publish the vendor's domain to count at all), so it is shown at
		// any domain proof. Only tier 3 also needs DNS (domain-proof.ts).
		vendor.id ? stripeBusiness(vendor.id, vendor.domain) : Promise.resolve(null),
		vendor.id ? hostCount(vendor.id) : Promise.resolve(0),
		observedSince(vendor.slug),
		// History is bound to the vendor's hosts, so it only means anything once
		// the domain is proven by DNS.
		vendor.id && vendor.domainVerified ? reportedHistory(vendor.id, attributable) : Promise.resolve(null),
	]);
	const wall = vendor.id && vendor.domainVerified ? await readLogoWall(vendor.id) : null;
	// Logos are named only from the vendor's own public wall, only when on that
	// page and observed signing in.
	const logos = wall ? publicLogos(wall, new Set(attributable)) : null;
	const now = new Date().toISOString();
	const observed = attributable.length > 0;
	const proven = proof !== "none";
	const [display, rawGrowth, retention] = await Promise.all([
		vendor.id ? displayFor(vendor.id) : Promise.resolve({ ...DEFAULT_DISPLAY }),
		proven ? growthFor(vendor.slug) : Promise.resolve(null),
		proven ? retentionFor(vendor.slug, vendor.domain) : Promise.resolve(null),
	]);
	const firstSeen = firstObserved ?? (observed ? now : null);
	const growth = rawGrowth ? markPartialMonths(rawGrowth, firstSeen) : null;
	if (logos && !display.logo_names) delete logos.companies;


	return applyDisplay({
		vendor: vendor.slug,
		kind: "aggregate",
		domain: vendor.domain,
		domain_verified_since: vendor.domainVerified && vendor.domainVerifiedAt ? new Date(vendor.domainVerifiedAt).toISOString() : null,
		domain_proof: proof,
		domain_verified: proof === "dns",
		hosts: vendor.domainVerified ? hosts : 0,
		// Present only when Stripe is connected: a proof never says what's missing.
		...(business ? { stripe_account_bound: true, stripe_binding: business.binding, stripe_business: business } : {}),
		window_days: WINDOW_DAYS,
		companies_observed: attributable.length,
		...summed,
		domains_excluded: excluded.length,
		observed_since: firstSeen,
		tier: tierForProof(observed, proof, stripeBusinessConfirms(business)),
		vendor_stated: history ? ["reported_history"] : [],
		...(history ? { reported_history: history } : {}),
		...(logos ? { logos } : {}),
		...(growth ? { growth } : {}),
		...(retention ? { retention } : {}),
		observed_through: now,
		published_at: now,
		next_snapshot_at: nextSnapshotAt(now),
		verify: verifyLink(vendor.slug, null, now),
		...withDisclosure(vendor.name, vendor.issuerAffiliation),
		method: methodUrl(METHOD_PATH),
	}, display);
}

/** The fields each hideable section removes. */
const SECTION_FIELDS: Record<DisplaySection, (keyof AggregateBody)[]> = {
	sessions: ["sessions", "signups", "logins"],
	reported_history: ["reported_history"],
	logos: ["logos"],
	stripe_business: ["stripe_business", "stripe_account_bound", "stripe_binding"],
	observed_since: ["observed_since"],
	hosts: ["hosts"],
	growth: ["growth"],
	retention: ["retention"],
};

/**
 * Omit what the vendor chose to hide, and say nothing about it: a hidden
 * section looks exactly like one with no data. Pure. The tier is computed
 * before this and is never affected; `vendor_stated` only lists fields still
 * present.
 */
export function applyDisplay<T extends Omit<AggregateBody, "prev_hash">>(body: T, display: DisplaySettings): T {
	const out: Record<string, unknown> = { ...body };
	for (const section of hiddenSections(display)) {
		for (const field of SECTION_FIELDS[section]) delete out[field];
	}
	if (Array.isArray(out.vendor_stated)) out.vendor_stated = (out.vendor_stated as string[]).filter((f) => f in out);
	return out as T;
}

/**
 * Memoised per hour — see hourly-memo.ts for how
 * long a chain still waiting on this hour's freeze is held.
 */
const chainCache = createHourlyMemo<{ chain: SignedAggregate[] | null; complete: boolean }>((v) => v.complete);

function hourBucket(): number {
	return Math.floor(Date.now() / (SNAPSHOT_CADENCE_SECONDS * 1000));
}

/**
 * Sign one aggregate onto whatever precedes it.
 *
 * Called by the hourly freeze, which is the only thing whose output is served
 * in production (see buildChainFor below).
 */
export async function signAggregate(
	vendorSlug: string,
	prevHash: string
): Promise<SignedAggregate | null> {
	const body = await aggregateBody(vendorSlug);
	if (!body) return null;

	// Vendor-scoped fraud features, unfiltered by domain. Supplied explicitly
	// because countersign cannot derive them — there is no customer to look
	// up. The `customer` field is a label on the scorer's side, never a key, so
	// it names the claim instead.
	const features = await fraudFeatures(vendorSlug, "*aggregate*", null);

	return signAttestation({ ...body, prev_hash: prevHash }, features);
}

/**
 * The published chain: exactly the rows the hourly freeze has written.
 *
 * Nothing signed on the side. A
 * live entry signed per instance carried a `verify` link to a snapshot that was
 * never stored, so /verify called our own document a forgery. Null until the
 * first freeze. Development signing is the one exception, because the freeze
 * refuses to persist dev-key signatures and a local checkout would otherwise
 * show nothing.
 */
async function buildChainFor(vendorSlug: string): Promise<{ chain: SignedAggregate[] | null; complete: boolean }> {
	const persisted = await loadAggregateHistory(vendorSlug);
	const frozen = persisted.map((p) => p.attestation);
	if (persisted.at(-1)?.hourBucket === hourBucket()) return { chain: frozen, complete: true };
	if (!isDemonstration()) return { chain: frozen.length ? frozen : null, complete: false };

	const tail = frozen.at(-1);
	const fresh = await signAggregate(vendorSlug, tail ? snapshotHash(tail) : GENESIS_HASH);
	return { chain: fresh ? [...frozen, fresh] : null, complete: false };
}

/** A vendor's full aggregate history, oldest first. */
export async function vendorAggregateChain(vendorSlug: string): Promise<SignedAggregate[] | null> {
	const { chain } = await chainCache(`${vendorSlug}/${hourBucket()}`, () => buildChainFor(vendorSlug));
	return chain;
}

export async function vendorAggregate(vendorSlug: string): Promise<SignedAggregate | null> {
	const chain = await vendorAggregateChain(vendorSlug);
	return chain ? chain[chain.length - 1] : null;
}

/**
 * The two gated doors — what `/attest/{vendor}` and `/attest/{vendor}/chain`
 * serve. A vendor is private until someone publishes it (fixtures/vendors.ts,
 * `findPublishedVendor`), and the aggregate is the surface that made that
 * matter: creating a vendor used to publish a signed count of their customers
 * at the moment the row existed, zeros first and then real numbers, without
 * anyone choosing to say either.
 *
 * The ungated pair above stays ungated on purpose. `signAggregate` is what the
 * hourly freeze calls and `aggregateBody` is what the staff roster calls —
 * both must keep running while a vendor is private, or the chain grows a hole
 * across exactly the weeks a vendor spends watching it work before going
 * public, and publishing would mean rebuilding history rather than flipping a
 * flag.
 */
export async function publishedVendorAggregateChain(vendorSlug: string): Promise<SignedAggregate[] | null> {
	if (!(await findPublishedVendor(vendorSlug))) return null;
	return vendorAggregateChain(vendorSlug);
}

export async function publishedVendorAggregate(vendorSlug: string): Promise<SignedAggregate | null> {
	const chain = await publishedVendorAggregateChain(vendorSlug);
	return chain ? chain[chain.length - 1] : null;
}

/** The bytes a verifier checks — exposed so tests can assert the signed form. */
export function aggregateBytes(signed: SignedAggregate): Buffer {
	const { signature: _sig, ...rest } = signed;
	return canonicalBytes(rest);
}
