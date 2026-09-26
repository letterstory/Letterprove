import { describe, expect, it } from "vitest";
import { computeAgenticReadCharge, formatUsd } from "./agentic-reads";

describe("computeAgenticReadCharge", () => {
	it("charges nothing for zero reads", () => {
		expect(computeAgenticReadCharge(0)).toEqual({
			totalReads: 0,
			tier2Reads: 0,
			tier3Reads: 0,
			amountCents: 0,
		});
	});

	it("charges nothing up to and including the free boundary (25)", () => {
		expect(computeAgenticReadCharge(25).amountCents).toBe(0);
	});

	it("charges the tier-2 rate starting at read 26", () => {
		expect(computeAgenticReadCharge(26)).toEqual({
			totalReads: 26,
			tier2Reads: 1,
			tier3Reads: 0,
			amountCents: 8,
		});
	});

	it("charges every read 26-500 at the tier-2 rate, none at tier-3, at the 500 boundary", () => {
		expect(computeAgenticReadCharge(500)).toEqual({
			totalReads: 500,
			tier2Reads: 475,
			tier3Reads: 0,
			amountCents: 3800,
		});
	});

	it("starts tier-3 billing at read 501", () => {
		expect(computeAgenticReadCharge(501)).toEqual({
			totalReads: 501,
			tier2Reads: 475,
			tier3Reads: 1,
			amountCents: 3820,
		});
	});

	it("caps tier-2 reads at 475 and bills the rest at tier-3 for high volume", () => {
		expect(computeAgenticReadCharge(1000)).toEqual({
			totalReads: 1000,
			tier2Reads: 475,
			tier3Reads: 500,
			amountCents: 13_800,
		});
	});

	it("floors a fractional count and clamps a negative one to zero", () => {
		expect(computeAgenticReadCharge(26.9).tier2Reads).toBe(1);
		expect(computeAgenticReadCharge(-5)).toEqual({
			totalReads: 0,
			tier2Reads: 0,
			tier3Reads: 0,
			amountCents: 0,
		});
	});
});

describe("formatUsd", () => {
	it("formats whole and fractional cents as USD", () => {
		expect(formatUsd(3800)).toBe("$38.00");
		expect(formatUsd(8)).toBe("$0.08");
		expect(formatUsd(0)).toBe("$0.00");
	});
});
