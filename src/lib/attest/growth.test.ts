import { describe, expect, it } from "vitest";
import { markPartialMonths } from "./growth";

describe("markPartialMonths: month in progress", () => {
  it("marks the current month in_progress and earlier months not", () => {
    const now = Date.UTC(2026, 9, 14, 12);
    const out = markPartialMonths(
      [
        { month: "2026-08", companies_observed: 50 },
        { month: "2026-09", companies_observed: 118 },
        { month: "2026-10", companies_observed: 90 },
      ],
      "2026-07-01T00:00:00Z",
      now,
    );
    expect(out.map((p) => Boolean(p.in_progress))).toEqual([
      false,
      false,
      true,
    ]);
    expect(out.every((p) => !p.partial)).toBe(true);
  });
  it("marks in_progress even without an observation start", () => {
    const now = Date.UTC(2026, 9, 14, 12);
    expect(
      markPartialMonths(
        [{ month: "2026-10", companies_observed: 9 }],
        null,
        now,
      )[0].in_progress,
    ).toBe(true);
  });
});
