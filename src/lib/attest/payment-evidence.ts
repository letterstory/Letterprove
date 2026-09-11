/**
 * Stripe-corroborated payment for one customer domain — the tier-3 input.
 *
 * Read from `vendor_payment_evidence`, which the Stripe sync fills. Never
 * fetched from Stripe here: building an attestation must not depend on a third
 * party's API being reachable, or a Stripe outage would silently drop every
 * vendor from tier 3 to tier 2 and change what the published document says.
 *
 * The reason this is worth a whole tier: every other signal in the system
 * originates, at root, with the vendor. The script runs on their site, the
 * customer list is theirs, the domain is theirs. An invoice that settled
 * through a processor is the first fact in the chain that costs the vendor
 * real money to produce — see src/lib/stripe/map.ts for exactly which
 * subscriptions clear that bar, and for what a determined vendor can still do.
 *
 * EVIDENCE GOES STALE, which is the other half of the claim. A row here is a
 * present-tense assertion that a named company pays this vendor right now, and
 * the only thing that can ever contradict it is the next successful sync. A
 * vendor who revokes their own Stripe key stops those syncs, so without a
 * ceiling on age the last favourable row stands for ever and the vendor is the
 * one who chose when to stop the clock. Past the ceiling this reads as absent:
 * not a claim that they stopped paying, just an honest refusal to keep
 * asserting something nothing has confirmed since yesterday.
 */

import { dbClient } from "@/lib/db/client";

/**
 * How old evidence may be before it stops counting.
 *
 * The Stripe sync cron runs hourly (vercel.json), so a day is twenty-four
 * consecutive missed or failed syncs. Generous enough that an outage on
 * Stripe's side or ours does not drop every vendor a tier over one bad hour,
 * short enough that "corroborated" never means "corroborated last week".
 */
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

/** The oldest `synced_at` still worth reading, as an ISO timestamp. */
function freshnessFloor(): string {
	return new Date(Date.now() - MAX_EVIDENCE_AGE_MS).toISOString();
}

export interface PaymentEvidence {
	/** ISO 4217, lower case as Stripe returns it. */
	currency: string;
	/**
	 * Minor units per month. An integer, always — canonical.ts serialises
	 * numbers with JSON.stringify and is explicitly NOT float-safe, so a
	 * fractional amount here would break byte-level agreement between our
	 * signature and an independent verifier's.
	 */
	monthlyAmount: number;
	/** Earliest active subscription start, ISO. */
	since: string;
	subscriptionCount: number;
}

export async function paymentEvidenceFor(
	vendorId: string,
	domain: string
): Promise<PaymentEvidence | null> {
	const db = dbClient();
	if (!db) return null;

	const { data, error } = await db
		.from("vendor_payment_evidence")
		.select("currency, monthly_amount, since, subscription_count, synced_at")
		.eq("vendor_id", vendorId)
		.eq("domain", domain)
		// Filtered in the query rather than after the read, so a stale row is
		// indistinguishable from an absent one everywhere downstream.
		.gte("synced_at", freshnessFloor())
		.maybeSingle();

	if (error || !data) {
		// Absent is the safe answer and the common one: most customers have no
		// payment evidence, and a failed read must not invent any.
		return null;
	}

	const amount = Number(data.monthly_amount);
	// The column is bigint, which supabase-js can hand back as a string. A
	// non-integer here would poison canonicalisation, so refuse rather than
	// round — no tier-3 claim is better than an unverifiable one.
	if (!Number.isSafeInteger(amount)) {
		console.error("[letterprove:payment] non-integer monthly_amount for", domain);
		return null;
	}

	// A zero is not a smaller payment, it is the absence of one, and published
	// as `contract_monthly: 0` inside a signed body it reads as the claim "this
	// company pays us nothing". map.ts refuses to write one; this refuses to
	// read one, because the write path is not the only way a row can arrive.
	if (amount < 1) {
		console.error("[letterprove:payment] non-positive monthly_amount for", domain);
		return null;
	}

	return {
		currency: data.currency,
		monthlyAmount: amount,
		since: data.since,
		subscriptionCount: data.subscription_count,
	};
}

/**
 * How many customer domains currently carry payment evidence.
 *
 * Null, never 0, when there is no datastore or the count could not be read.
 * This number is what tells a vendor their Stripe connection is doing
 * something, and a failed read rendered as "0 domains corroborated" would
 * report their connection as broken at the moment it is fine. It is the same
 * "a failed read is not a zero" rule the tier report follows.
 */
export async function paymentEvidenceCount(vendorId: string): Promise<number | null> {
	const db = dbClient();
	if (!db) return null;

	const { count, error } = await db
		.from("vendor_payment_evidence")
		.select("*", { count: "exact", head: true })
		.eq("vendor_id", vendorId)
		// The same freshness floor the read applies. A count that included rows
		// too old to publish would tell a vendor their connection is producing
		// evidence at the moment it has quietly stopped.
		.gte("synced_at", freshnessFloor());

	if (error || typeof count !== "number") return null;
	return count;
}
