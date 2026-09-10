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
 * customer list is theirs, the domain is theirs. Payment read from the
 * vendor's own Stripe account is the first fact that does NOT pass through
 * their hands — they can cancel a subscription, but they cannot fabricate one
 * without defrauding themselves.
 */

import { dbClient } from "@/lib/db/client";

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
		.select("currency, monthly_amount, since, subscription_count")
		.eq("vendor_id", vendorId)
		.eq("domain", domain)
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
		.eq("vendor_id", vendorId);

	if (error || typeof count !== "number") return null;
	return count;
}
