/**
 * What each vendor owes this month for agentic reads — the staff read side of
 * usage billing. Reads agentic_read_rollups (updated daily by
 * /api/cron/agentic-reads-rollup) and prices it with
 * src/lib/billing/agentic-reads.ts.
 *
 * No Stripe wiring here, deliberately: Letterprove has no platform Stripe
 * account of its own yet (LETTERPROVE_STRIPE_ENCRYPTION_KEY encrypts a
 * VENDOR's own key for corroboration — a different account, a different
 * direction of money). This answers "what would we invoice right now" so the
 * number exists and is checkable before any charge is wired up or any money
 * moves.
 */

import { dbClient } from "@/lib/db/client";
import { computeAgenticReadCharge, formatUsd, type AgenticReadCharge } from "@/lib/billing/agentic-reads";

export interface VendorReadBilling {
	vendorSlug: string;
	billingMonth: string;
	charge: AgenticReadCharge;
	amountFormatted: string;
}

/** First-of-month, UTC, as YYYY-MM-DD — matches agentic_read_rollups.billing_month. */
export function currentBillingMonth(now: Date = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export async function agenticReadBillingReport(now: Date = new Date()): Promise<VendorReadBilling[] | null> {
	const db = dbClient();
	// Null, not an empty report: "no datastore" and "nobody read anything
	// this month" must not look the same to whoever reads this.
	if (!db) return null;

	const billingMonth = currentBillingMonth(now);
	const { data, error } = await db
		.from("agentic_read_rollups")
		.select("vendor_slug, read_count")
		.eq("billing_month", billingMonth);
	if (error) {
		console.error("[letterprove:billing] agentic read report query failed", error.message);
		return null;
	}

	return ((data ?? []) as { vendor_slug: string; read_count: number }[])
		.map((row) => {
			const charge = computeAgenticReadCharge(row.read_count);
			return {
				vendorSlug: row.vendor_slug,
				billingMonth,
				charge,
				amountFormatted: formatUsd(charge.amountCents),
			};
		})
		.sort((a, b) => b.charge.amountCents - a.charge.amountCents);
}
