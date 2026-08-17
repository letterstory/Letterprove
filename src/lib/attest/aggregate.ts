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
 * NOT CHAINED OR FROZEN YET. This serves a single fresh entry per hour rather
 * than a persisted history. Chaining it needs its own storage and cadence
 * design alongside rollup/freeze.ts, and the same immutability caveat applies
 * that already does for customer snapshots — a wrong entry is permanent. That
 * is a deliberate follow-up, not an oversight.
 */

import { canonicalBytes } from "./canonical";
import { fraudFeatures } from "./fraud-features";
import { methodUrl } from "./method";
import { signAttestation } from "./sign";
import { GENESIS_HASH } from "./verify";
import { partitionDomains } from "@/lib/identity/domains";
import { findVendor } from "@/lib/fixtures/vendors";
import { dbClient } from "@/lib/db/client";
import type { Tier } from "./types";

const METHOD_PATH = "src/lib/attest/aggregate.ts";
const TTL_SECONDS = 3600;
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
	observed_through: string;
	published_at: string;
	ttl: number;
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
 * What the evidence supports for a vendor-wide claim.
 *
 * Tier 2, not 1: every observation behind it was seen by our script in a real
 * browser AND bound to facts the vendor did not supply — our receipt
 * timestamp and the request origin (decision 14: two of the three
 * infrastructure facts are enough for now; ASN is still uncaptured).
 *
 * Capped at 0 with nothing observed, for the same reason `earned()` caps a
 * customer claim: a tier is a statement about evidence, and there isn't any.
 */
function earnedTier(observed: boolean): Tier {
	return observed ? 2 : 0;
}

/** Every domain this vendor was observed for in the window, with its totals. */
async function observedTotals(vendorSlug: string): Promise<Map<string, Totals> | null> {
	const db = dbClient();
	if (!db) return null;

	const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const { data, error } = await db
		.from("hot_rollups")
		.select("domain, sessions, signups, logins")
		.eq("vendor_slug", vendorSlug)
		.gte("window_start", since);

	if (error) {
		console.error("[letterprove:aggregate] rollup query failed", error.message);
		return null;
	}

	const totals = new Map<string, Totals>();
	for (const row of (data ?? []) as (Totals & { domain: string })[]) {
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

	const { attributable, excluded } = partitionDomains(totals.keys());
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

	const now = new Date().toISOString();
	return {
		vendor: vendor.slug,
		kind: "aggregate",
		window_days: WINDOW_DAYS,
		companies_observed: attributable.length,
		...summed,
		domains_excluded: excluded.length,
		tier: earnedTier(attributable.length > 0),
		observed_through: now,
		published_at: now,
		ttl: TTL_SECONDS,
		method: methodUrl(METHOD_PATH),
	};
}

/**
 * Memoised per hour, matching the customer chains: the page and the JSON
 * endpoint must serve byte-identical documents, or the difference reads to a
 * verifier exactly like tampering.
 */
const cache = new Map<string, Promise<SignedAggregate | null>>();

function hourBucket(): number {
	return Math.floor(Date.now() / (TTL_SECONDS * 1000));
}

async function build(vendorSlug: string): Promise<SignedAggregate | null> {
	const body = await aggregateBody(vendorSlug);
	if (!body) return null;

	// Vendor-scoped fraud features: the same shape the customer path sends,
	// unfiltered by domain. Supplied explicitly because countersign cannot
	// derive them — there is no customer to look up. The `customer` field is a
	// label on the scorer's side, never a key, so it names the claim instead.
	const features = await fraudFeatures(vendorSlug, "*aggregate*", null);

	return signAttestation({ ...body, prev_hash: GENESIS_HASH }, features);
}

export async function vendorAggregate(vendorSlug: string): Promise<SignedAggregate | null> {
	const key = `${vendorSlug}/${hourBucket()}`;
	let entry = cache.get(key);
	if (!entry) {
		entry = build(vendorSlug);
		// Evict a rejection so the next request retries rather than serving an
		// hour of failures after the cause has cleared.
		entry.catch(() => cache.delete(key));
		cache.set(key, entry);
	}
	return entry;
}

/** The bytes a verifier checks — exposed so tests can assert the signed form. */
export function aggregateBytes(signed: SignedAggregate): Buffer {
	const { signature: _sig, ...rest } = signed;
	return canonicalBytes(rest);
}
