import { describe, expect, it } from "vitest";
import { isListed, type VendorFixture } from "./vendors";

const v = (proofsListed?: boolean) => ({ slug: "acme", proofsPublishedAt: "2026-10-01T00:00:00Z", proofsListed }) as unknown as VendorFixture;

describe("isListed", () => {
	it("reads absent as listed, so fixtures and older rows keep appearing", () => {
		expect(isListed(v(undefined))).toBe(true);
		expect(isListed(v(true))).toBe(true);
	});
	it("is false only for an explicitly unlisted vendor", () => {
		expect(isListed(v(false))).toBe(false);
	});
});
