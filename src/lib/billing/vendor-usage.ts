import { dbClient } from "@/lib/db/client";
import { currentBillingMonth, previousBillingMonth } from "@/lib/staff/billing";
import {
  AGENTIC_READ_PRICING,
  computeAgenticReadCharge,
} from "@/lib/billing/agentic-reads";

/**
 * One vendor's agentic-read usage, for that vendor to read about itself.
 *
 * The fleet-wide `agenticReadBillingReport` is the billing job's view: every
 * vendor, one closed month, with the org to charge. A vendor needs the other
 * cut — its own month so far and what that comes to — or the first it hears of
 * usage pricing is an invoice. Same rollup table, same pricing function, so the
 * estimate shown here and the amount later billed cannot disagree.
 *
 * Month-to-date is as fresh as the daily rollup (`counted_at` says when), not
 * live: the rollup recomputes the current and previous month on each run.
 */
export interface VendorMonthUsage {
  billing_month: string;
  reads: number;
  tier2_reads: number;
  tier3_reads: number;
  amount_cents: number;
}

export interface VendorReadUsage {
  current: VendorMonthUsage & { counted_at: string | null };
  previous: VendorMonthUsage;
  pricing: {
    free_reads: number;
    tier2_ceiling: number;
    tier2_rate_cents: number;
    tier3_rate_cents: number;
  };
}

function month(billingMonth: string, reads: number): VendorMonthUsage {
  const charge = computeAgenticReadCharge(reads);
  return {
    billing_month: billingMonth,
    reads: charge.totalReads,
    tier2_reads: charge.tier2Reads,
    tier3_reads: charge.tier3Reads,
    amount_cents: charge.amountCents,
  };
}

/** Null when storage is unreachable — never a zeroed usage, which would read as "nothing owed". */
export async function vendorReadUsage(
  vendorSlug: string,
  now: Date = new Date(),
): Promise<VendorReadUsage | null> {
  const db = dbClient();
  if (!db) return null;

  const current = currentBillingMonth(now);
  const previous = previousBillingMonth(now);
  const { data, error } = await db
    .from("agentic_read_rollups")
    .select("billing_month, read_count, computed_at")
    .eq("vendor_slug", vendorSlug)
    .in("billing_month", [current, previous]);
  if (error) {
    console.error(
      "[letterprove:billing] vendor usage read failed",
      error.message,
    );
    return null;
  }

  const rows = (data ?? []) as {
    billing_month: string;
    read_count: number;
    computed_at: string;
  }[];
  const at = (m: string) => rows.find((r) => r.billing_month === m);

  return {
    current: {
      ...month(current, at(current)?.read_count ?? 0),
      counted_at: at(current)?.computed_at ?? null,
    },
    previous: month(previous, at(previous)?.read_count ?? 0),
    pricing: {
      free_reads: AGENTIC_READ_PRICING.freeReads,
      tier2_ceiling: AGENTIC_READ_PRICING.tier2Ceiling,
      tier2_rate_cents: AGENTIC_READ_PRICING.tier2RateCents,
      tier3_rate_cents: AGENTIC_READ_PRICING.tier3RateCents,
    },
  };
}
