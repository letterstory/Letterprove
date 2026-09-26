/**
 * Usage-based pricing for agentic proof/attest reads — how many cents a
 * vendor owes for one billing month's count of AI-agent reads.
 *
 * Bands, per vendor per month (Steve, 2026-09-26, after comparing against
 * the sibling metered products in the ls repo — shreds/writes/ledes charge
 * $2-5/unit for AI-compute work; a proof-page read is a signed DB row with no
 * inference behind it, priced accordingly lower):
 *   0–25 reads    free
 *   26–500 reads  $0.08/read
 *   500+ reads    $0.20/read, marginal — only the reads above 500
 *
 * Pure and pricing-table-driven so the numbers can move without touching the
 * shape of the calculation. Cents, not dollars, throughout — the unit every
 * Stripe amount in this codebase and in ls's metered/products.ts uses.
 */

export const AGENTIC_READ_PRICING = {
	freeReads: 25,
	tier2Ceiling: 500,
	tier2RateCents: 8,
	tier3RateCents: 20,
} as const;

export interface AgenticReadCharge {
	/** The count this charge was computed from, floored at 0. */
	totalReads: number;
	/** Reads billed at the tier-2 rate (26–500). */
	tier2Reads: number;
	/** Reads billed at the tier-3 rate (above 500). */
	tier3Reads: number;
	amountCents: number;
}

/** @param totalReads a billing month's agentic_read_rollups.read_count for one vendor. */
export function computeAgenticReadCharge(totalReads: number): AgenticReadCharge {
	const reads = Math.max(0, Math.trunc(totalReads));
	const { freeReads, tier2Ceiling, tier2RateCents, tier3RateCents } = AGENTIC_READ_PRICING;

	const billable = Math.max(0, reads - freeReads);
	const tier2Reads = Math.min(billable, tier2Ceiling - freeReads);
	const tier3Reads = Math.max(0, billable - tier2Reads);

	return {
		totalReads: reads,
		tier2Reads,
		tier3Reads,
		amountCents: tier2Reads * tier2RateCents + tier3Reads * tier3RateCents,
	};
}

/** "$38.00" — matches the formatting convention in ls's metered/products.ts. */
export function formatUsd(cents: number): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
