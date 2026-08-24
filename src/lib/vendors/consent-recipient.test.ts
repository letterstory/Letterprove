import { describe, expect, it } from "vitest";
import { checkConsentRecipient, domainOfEmail } from "./consent-recipient";

describe("domainOfEmail", () => {
	it("lowercases the domain so casing can't dodge the comparison", () => {
		expect(domainOfEmail("Jane@ACME.com")).toBe("acme.com");
	});

	it.each([
		["not an email", "acme.com"],
		["two ats", "a@b@acme.com"],
		["no local part", "@acme.com"],
		["no dot in host", "jane@localhost"],
		["trailing dot", "jane@acme.com."],
		["empty label", "jane@acme..com"],
		["embedded space", "jane doe@acme.com"],
		["non-string", 42],
	])("rejects %s", (_label, input) => {
		expect(domainOfEmail(input)).toBeNull();
	});
});

describe("checkConsentRecipient", () => {
	it("accepts an address on the customer's own domain", () => {
		expect(checkConsentRecipient("jane@acme.com", "acme.com")).toEqual({ ok: true, email: "jane@acme.com" });
	});

	it("accepts a subdomain, which still requires control of the customer's DNS", () => {
		expect(checkConsentRecipient("jane@mail.acme.com", "acme.com").ok).toBe(true);
	});

	it("compares case-insensitively in both directions", () => {
		expect(checkConsentRecipient("Jane@ACME.com", "Acme.Com").ok).toBe(true);
	});

	it("trims surrounding whitespace rather than rejecting a pasted address", () => {
		expect(checkConsentRecipient("  jane@acme.com  ", "acme.com")).toEqual({ ok: true, email: "jane@acme.com" });
	});

	/*
	 * The case this module exists for. A vendor attesting that Acme is their
	 * customer must not be able to route the approval to a mailbox they own —
	 * earned() treats countersigned_at as tier-4 proof ahead of the
	 * domain-verified and observed gates, so a self-approval publishes the
	 * strongest tier in the system with nothing behind it.
	 */
	it("refuses an address on the VENDOR's domain", () => {
		const result = checkConsentRecipient("me@vendor.com", "acme.com");
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("acme.com");
	});

	it("refuses a lookalike sibling domain", () => {
		expect(checkConsentRecipient("jane@acme.co.uk", "acme.com").ok).toBe(false);
	});

	/*
	 * `evilacme.com` ends with `acme.com` as a plain string. A naive
	 * endsWith check without the dot boundary would accept it, and it is
	 * registrable by anyone — including the vendor.
	 */
	it("refuses a domain that merely ends with the customer's, without a label boundary", () => {
		expect(checkConsentRecipient("jane@evilacme.com", "acme.com").ok).toBe(false);
	});

	it("refuses the customer domain as a suffix of a longer TLD-ish string", () => {
		expect(checkConsentRecipient("jane@acme.com.attacker.net", "acme.com").ok).toBe(false);
	});

	it.each([undefined, null, "", "   ", 7])("refuses a missing address (%p)", (input) => {
		expect(checkConsentRecipient(input, "acme.com").ok).toBe(false);
	});

	it("refuses when the customer has no domain, rather than accepting anything", () => {
		expect(checkConsentRecipient("jane@acme.com", "").ok).toBe(false);
	});
});
