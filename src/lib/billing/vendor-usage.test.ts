import { describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
  value: [] as unknown[],
  error: null as null | { message: string },
}));
vi.mock("@/lib/db/client", () => ({
  dbClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: async () => ({ data: rows.value, error: rows.error }),
        }),
      }),
    }),
  }),
}));

import { vendorReadUsage } from "./vendor-usage";

const NOW = new Date("2026-10-14T12:00:00Z");

describe("vendorReadUsage", () => {
  it("prices this month and last with the same bands the bill uses", async () => {
    rows.value = [
      {
        billing_month: "2026-10-01",
        read_count: 40,
        computed_at: "2026-10-14T03:15:00Z",
      },
      {
        billing_month: "2026-09-01",
        read_count: 620,
        computed_at: "2026-10-01T03:15:00Z",
      },
    ];
    rows.error = null;
    const usage = await vendorReadUsage("acme", NOW);
    // 40 reads: 25 free, 15 × $0.08.
    expect(usage?.current).toEqual({
      billing_month: "2026-10-01",
      reads: 40,
      tier2_reads: 15,
      tier3_reads: 0,
      amount_cents: 120,
      counted_at: "2026-10-14T03:15:00Z",
    });
    // 620 reads: 475 × $0.08 + 120 × $0.20.
    expect(usage?.previous.amount_cents).toBe(475 * 8 + 120 * 20);
    expect(usage?.pricing).toEqual({
      free_reads: 25,
      tier2_ceiling: 500,
      tier2_rate_cents: 8,
      tier3_rate_cents: 20,
    });
  });

  it("reads zero, not missing, for a month with no counted reads", async () => {
    rows.value = [];
    rows.error = null;
    const usage = await vendorReadUsage("acme", NOW);
    expect(usage?.current).toMatchObject({
      reads: 0,
      amount_cents: 0,
      counted_at: null,
    });
    expect(usage?.previous.reads).toBe(0);
  });

  it("is null when storage cannot be read, never a zeroed bill", async () => {
    rows.value = [];
    rows.error = { message: "boom" };
    expect(await vendorReadUsage("acme", NOW)).toBeNull();
  });
});
