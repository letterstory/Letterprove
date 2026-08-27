import { describe, expect, it, vi } from "vitest";
import { readAllRows } from "./read-all";
import { pagedQueryMock, MOCK_PAGE_SIZE } from "./paged-query-mock";

/**
 * The regression this file exists for produced no error and no warning — an
 * unbounded PostgREST select simply answers with the first 1000 rows. Measured
 * on production: `published_snapshots` held 1421 rows and returned exactly 1000.
 *
 * Every other test touching these readers uses a mock that returns everything
 * in one page, so none of them can tell a paged read from a truncated one. That
 * is what these assert.
 */

function rows(n: number) {
	return Array.from({ length: n }, (_, i) => ({ id: i }));
}

describe("readAllRows", () => {
	it("returns everything when the result fits in one page", async () => {
		const db = pagedQueryMock(rows(42));
		const out = await readAllRows<{ id: number }>("t", (from, to) =>
			(db.from("t") as { range: (a: number, b: number) => Promise<never> }).range(from, to),
		);

		expect(out).toHaveLength(42);
		expect(db.pageCount()).toBe(1);
	});

	/*
	 * The actual bug. 1421 rows is what production held when this was found; an
	 * unpaged read returns 1000 of them and reports success.
	 */
	it("keeps paging past the cap instead of stopping at 1000", async () => {
		const db = pagedQueryMock(rows(1421));
		const out = await readAllRows<{ id: number }>("t", (from, to) =>
			(db.from("t") as { range: (a: number, b: number) => Promise<never> }).range(from, to),
		);

		expect(out).toHaveLength(1421);
		expect(db.pageCount()).toBe(2);
		// Order preserved across the page boundary — a chain read depends on
		// `.at(-1)` being the genuinely newest entry.
		expect(out[0].id).toBe(0);
		expect(out.at(-1)!.id).toBe(1420);
	});

	it("handles a result that is an exact multiple of the page size", async () => {
		const db = pagedQueryMock(rows(MOCK_PAGE_SIZE * 2));
		const out = await readAllRows<{ id: number }>("t", (from, to) =>
			(db.from("t") as { range: (a: number, b: number) => Promise<never> }).range(from, to),
		);

		// Three requests, not two: a full page can't be distinguished from "more
		// to come", so it asks again and gets an empty page. One wasted round
		// trip beats silently dropping the tail.
		expect(out).toHaveLength(MOCK_PAGE_SIZE * 2);
		expect(db.pageCount()).toBe(3);
	});

	/*
	 * Errors must propagate, not degrade to a partial answer. Every caller
	 * separates "read failed" from "nothing there" — a failed telemetry read
	 * must never publish as a confident zero — and returning the pages that
	 * happened to succeed would erase that distinction.
	 */
	it("throws rather than returning the pages that succeeded", async () => {
		const db = pagedQueryMock(rows(50), { error: { message: "connection reset" } });

		await expect(
			readAllRows<{ id: number }>("rollups for acme", (from, to) =>
				(db.from("t") as { range: (a: number, b: number) => Promise<never> }).range(from, to),
			),
		).rejects.toThrow(/rollups for acme: connection reset/);
	});

	it("refuses to page forever if the query never shrinks", async () => {
		// Always answers with a full page — a query that never ends.
		let calls = 0;
		const endless = async () => {
			calls++;
			return { data: rows(MOCK_PAGE_SIZE), error: null };
		};

		await expect(readAllRows<{ id: number }>("endless", endless)).rejects.toThrow(/refusing to keep paging/);
		expect(calls).toBe(500);
	});

	it("labels the failure with the caller's own words, so a stack trace names the read", async () => {
		const db = pagedQueryMock(rows(1), { error: { message: "boom" } });
		const attempt = readAllRows<{ id: number }>("published history for acme/globex", (from, to) =>
			(db.from("t") as { range: (a: number, b: number) => Promise<never> }).range(from, to),
		);

		await expect(attempt).rejects.toThrow("published history for acme/globex: boom");
	});
});

/**
 * Guards the readers themselves. The fix is only load-bearing if these files
 * actually page — someone re-introducing a bare `.select().eq()` would break
 * nothing visible until a chain crossed 1000 rows, weeks later, permanently.
 */
describe("the readers that must never truncate", () => {
	it.each([
		["src/rollup/history.ts", "a customer's signed chain"],
		["src/rollup/aggregate-history.ts", "a vendor's aggregate chain"],
		["src/lib/attest/aggregate.ts", "rollups summed into a signed document"],
		["src/lib/tiers/report.ts", "rollups behind the observed view"],
		["src/lib/stripe/sync.ts", "observed domains for the payment join"],
	])("%s pages its read (%s)", async (file) => {
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(`${process.cwd()}/${file}`, "utf8");

		expect(source).toContain("readAllRows");
		expect(source).toContain(".range(from, to)");
	});
});

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
