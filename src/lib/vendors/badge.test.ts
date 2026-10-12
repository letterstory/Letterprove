import { describe, expect, it } from "vitest";
import { BADGE_TEXT, badgeHtml, proofPageUrl } from "./badge";

describe("footer badge", () => {
	it("links to the vendor's public proof page on the serving origin", () => {
		expect(proofPageUrl("https://app.letterprove.com", "letter-dev")).toBe("https://app.letterprove.com/proofs/letter-dev");
		expect(badgeHtml("https://app.letterprove.com", "letter-dev")).toContain('href="https://app.letterprove.com/proofs/letter-dev"');
	});

	it("says what it says and loads nothing from anywhere", () => {
		const html = badgeHtml("https://app.letterprove.com", "acme");
		expect(html).toContain(BADGE_TEXT);
		expect(html).not.toMatch(/<script|<img|src=|url\(/);
	});

	it("cannot be broken out of by a slug", () => {
		expect(badgeHtml("https://app.letterprove.com", 'a"><script>')).not.toContain("<script>");
	});
});
