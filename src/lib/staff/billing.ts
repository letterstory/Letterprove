/**
 * What each vendor owes for agentic reads, and which Letterstory org to bill
 * for it — the read side of usage billing.
 *
 * Reads agentic_read_rollups (updated daily by /api/cron/agentic-reads-rollup)
 * and vendors.letterstory_org_id (migration 20260825060000: a vendor IS a
 * Letterstory org, 1:1), prices the count with
 * src/lib/billing/agentic-reads.ts, and joins the two in application code —
 * two tables, one query each, joined by vendor_slug in JS, the same shape
 * staff/vendors.ts's membersByVendor() already uses for vendor_members. No
 * real SQL join exists across these because letterstory_org_id is a soft
 * reference (organizations lives in Letterstory's own database).
 *
 * No Stripe wiring here, deliberately: per Steve's 2026-09-26 call, Letterprove
 * never holds a Stripe credential — Letterstory does the actual charging
 * (reusing its existing metered-billing engine and the org's existing Stripe
 * customer), reached via the `agentic_read_billing` staff:read tool. This
 * module is what that tool calls.
 */

import { dbClient } from "@/lib/db/client";
import { computeAgenticReadCharge, formatUsd, type AgenticReadCharge } from "@/lib/billing/agentic-reads";

export interface VendorReadBilling {
	vendorSlug: string;
	/** Null when this vendor has no linked Letterstory org (see the migration's own comment)
	 *  — Letterstory cannot bill it and should surface that as a gap, not silently drop it. */
	letterstoryOrgId: string | null;
	billingMonth: string;
	charge: AgenticReadCharge;
	amountFormatted: string;
}

/** First-of-month, UTC, as YYYY-MM-DD — matches agentic_read_rollups.billing_month. */
export function currentBillingMonth(now: Date = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/**
 * First-of-PREVIOUS-month, UTC, as YYYY-MM-DD. What a monthly invoicing job
 * actually wants by default: the current month is still accumulating reads
 * (the daily rollup keeps recomputing it), so invoicing it would bill a
 * partial count. The previous month stops changing once nothing dates into
 * it any more — safe to invoice a few days into the new month.
 */
export function previousBillingMonth(now: Date = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
}

export interface AgenticReadBillingReportOptions {
	/** YYYY-MM-01. Defaults to the previous calendar month relative to `now` — see previousBillingMonth. */
	billingMonth?: string;
	/** Only matters when billingMonth is omitted. */
	now?: Date;
}

export async function agenticReadBillingReport(
	options: AgenticReadBillingReportOptions = {}
): Promise<VendorReadBilling[] | null> {
	const db = dbClient();
	// Null, not an empty report: "no datastore" and "nobody read anything
	// that month" must not look the same to whoever reads this.
	if (!db) return null;

	const billingMonth = options.billingMonth ?? previousBillingMonth(options.now);

	const { data: rollupRows, error: rollupError } = await db
		.from("agentic_read_rollups")
		.select("vendor_slug, read_count")
		.eq("billing_month", billingMonth);
	if (rollupError) {
		console.error("[letterprove:billing] agentic read report query failed", rollupError.message);
		return null;
	}

	const rows = (rollupRows ?? []) as { vendor_slug: string; read_count: number }[];
	if (rows.length === 0) return [];

	const { data: vendorRows, error: vendorError } = await db
		.from("vendors")
		.select("slug, letterstory_org_id")
		.in(
			"slug",
			rows.map((r) => r.vendor_slug)
		);
	if (vendorError) {
		console.error("[letterprove:billing] vendor org lookup failed", vendorError.message);
		return null;
	}
	const orgIdBySlug = new Map(
		((vendorRows ?? []) as { slug: string; letterstory_org_id: string | null }[]).map((v) => [
			v.slug,
			v.letterstory_org_id,
		])
	);

	return rows
		.map((row) => {
			const charge = computeAgenticReadCharge(row.read_count);
			return {
				vendorSlug: row.vendor_slug,
				letterstoryOrgId: orgIdBySlug.get(row.vendor_slug) ?? null,
				billingMonth,
				charge,
				amountFormatted: formatUsd(charge.amountCents),
			};
		})
		.sort((a, b) => b.charge.amountCents - a.charge.amountCents);
}
