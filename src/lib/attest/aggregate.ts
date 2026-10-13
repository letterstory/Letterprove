/**
 * The vendor-level attestation — the one claim we can publish before anyone
 * consents to be named.
 *
 * Naming a customer discloses *their* data and needs their say-so (README §
 * Consent). Counting them does not: *"12 companies observed, 47 sessions in
 * the last 30 days"* identifies nobody. That makes this the only verifiable
 * thing Letterprove can say about a real vendor today — every per-customer
 * proof is withheld until consent lands, so `/proofs/lettertrace` is
 * otherwise empty despite a month of genuine observations.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. Not "customers" — "companies observed".
 * A session from `someone@acme.com` proves a person at Acme used the product;
 * it does not prove Acme buys it. That is a commercial fact we do not hold,
 * and the gap between those two sentences is the whole reason this product
 * exists. The wire field is `companies_observed` for the same reason.
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
 * The immutability caveat that applies to customer snapshots applies here too:
 * a frozen entry is permanent, so a wrong one is permanent. That is why the
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
import { paymentScopeFor } from "./payment-evidence";
import { nextSnapshotAt, SNAPSHOT_CADENCE_SECONDS } from "./cadence";
import { verifyLink } from "./verify-link";
import { withDisclosure } from "./issuer";

const METHOD_PATH = "src/lib/attest/aggregate.ts";
const WINDOW_DAYS = 30;

export interface AggregateBody {
	vendor: string;
	/** Distinguishes this from a customer attestation at a glance. */
	kind: "aggregate";
	window_days: number;
	/** Distinct company domains observed. NOT a customer count — see module doc. */
	companies_observed: number;
	sessions: number;
	signups: number;
	logins: number;
	/** Observed domains that can never name a company: free-mail, internal, malformed. */
	domains_excluded: number;
	tier: Tier;
	/**
	 * Fields that are the vendor's statement rather than evidence. Always empty
	 * here — every figure in the aggregate is counted from observed events — and
	 * published anyway so the absence is stated, not inferred. Absent before
	 * 2026-10-13.
	 */
	vendor_stated?: string[];
	/**
	 * Which of the vendor's Stripe products its payment corroboration counts,
	 * present only while Stripe is connected. Counts, never product names: a
	 * reader is owed whether "pays" means everything the account bills or only
	 * the products the vendor said are this product. Absent before 2026-10-13.
	 */
	payment_scope?: PaymentScope;
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

interface Totals {
	sessions: number;
	signups: number;
	logins: number;
}

/**
 * What the evidence supports for a vendor-wide claim. The same rule as a
 * customer claim in body.ts's earned(), minus payment: the aggregate makes no
 * commercial claim, so it tops out at tier 1.
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
export function earnedAggregateTier(observed: boolean, domainVerified: boolean): Tier {
	return observed && domainVerified ? 1 : 0;
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

	const scope = vendor.id ? await paymentScopeFor(vendor.id) : null;
	const now = new Date().toISOString();
	return {
		vendor: vendor.slug,
		kind: "aggregate",
		window_days: WINDOW_DAYS,
		companies_observed: attributable.length,
		...summed,
		domains_excluded: excluded.length,
		tier: earnedAggregateTier(attributable.length > 0, vendor.domainVerified),
		vendor_stated: [],
		...(scope ? { payment_scope: scope } : {}),
		observed_through: now,
		published_at: now,
		next_snapshot_at: nextSnapshotAt(now),
		verify: verifyLink(vendor.slug, null, now),
		...withDisclosure(vendor.name, vendor.issuerAffiliation),
		method: methodUrl(METHOD_PATH),
	};
}

/**
 * Memoised per hour, matching the customer chains — see hourly-memo.ts for how
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

	// Vendor-scoped fraud features: the same shape the customer path sends,
	// unfiltered by domain. Supplied explicitly because countersign cannot
	// derive them — there is no customer to look up. The `customer` field is a
	// label on the scorer's side, never a key, so it names the claim instead.
	const features = await fraudFeatures(vendorSlug, "*aggregate*", null);

	return signAttestation({ ...body, prev_hash: prevHash }, features);
}

/**
 * The published chain: exactly the rows the hourly freeze has written.
 *
 * Nothing signed on the side, for the reason given at length in proofs.ts: a
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
