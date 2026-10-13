import { describe, expect, it } from "vitest";
import { leadSentence } from "./lead";

describe("leadSentence", () => {
	it("calls an unaffiliated vendor's proof third-party", () => {
		expect(leadSentence(false)).toContain("a third-party attestation with open-source logic.");
	});
	it("never says third-party when the vendor shares an owner with Letterprove", () => {
		expect(leadSentence(true)).not.toContain("third-party");
		expect(leadSentence(true)).toContain("an attestation with open-source logic.");
	});
});
