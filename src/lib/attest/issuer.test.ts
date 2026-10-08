import { describe, expect, it } from "vitest";
import { affiliationDisclosure, withDisclosure } from "./issuer";

describe("issuer disclosure", () => {
	it("names the shared owner for an affiliated vendor", () => {
		expect(affiliationDisclosure("Lettertrace", "Letter Company")).toBe(
			"Letterprove and Lettertrace are both operated by Letter Company. The same collector, code and signing apply to it as to any other vendor, and every figure can be checked the same way.",
		);
	});

	it("adds nothing for an independent vendor — absence, not a false-y field", () => {
		expect(affiliationDisclosure("Acme", null)).toBeNull();
		expect(withDisclosure("Acme", null)).toEqual({});
		expect(withDisclosure("Lettertrace", "Letter Company")).toHaveProperty("issuer_affiliation");
	});
});
