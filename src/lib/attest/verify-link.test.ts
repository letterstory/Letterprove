import { describe, expect, it } from "vitest";
import { parseVerifyPath, snapshotStamp, verifyLink } from "./verify-link";

describe("verify links", () => {
	it("stamps a snapshot by its published_at, URL-safe", () => {
		expect(snapshotStamp("2026-10-08T17:01:21.613Z")).toBe("20261008T170121613Z");
	});

	it("points at the production host for an aggregate and for a named customer", () => {
		expect(verifyLink("lettertrace", null, "2026-10-08T17:01:21.613Z")).toBe(
			"https://app.letterprove.com/verify/lettertrace/20261008T170121613Z",
		);
		expect(verifyLink("vantage", "acme-corp", "2026-10-08T17:01:21.613Z")).toBe(
			"https://app.letterprove.com/verify/vantage/acme-corp/20261008T170121613Z",
		);
	});

	it("round-trips through the route's parser, and refuses any other shape", () => {
		expect(parseVerifyPath(["20261008T170121613Z"])).toEqual({ customer: null, stamp: "20261008T170121613Z" });
		expect(parseVerifyPath(["acme-corp", "20261008T170121613Z"])).toEqual({ customer: "acme-corp", stamp: "20261008T170121613Z" });
		expect(parseVerifyPath(["2026-10-08"])).toBeNull();
		expect(parseVerifyPath(["a", "b", "20261008T170121613Z"])).toBeNull();
		expect(parseVerifyPath([])).toBeNull();
	});
});
