import { describe, expect, it } from "vitest";
import { classifyDomain, isAttributable, partitionDomains } from "./domains";

describe("classifyDomain", () => {
	it("proposes an ordinary corporate domain as a company", () => {
		expect(classifyDomain("tenevents.com").kind).toBe("company");
		expect(classifyDomain("snappykraken.com").kind).toBe("company");
		// Multi-part public suffixes are companies too — the suffix is not the
		// identity, the registration under it is.
		expect(classifyDomain("acme.co.uk").kind).toBe("company");
	});

	// The row that turned this from a hypothetical into a real one: gmail.com
	// was in hot_rollups within an hour of the first live install.
	it("refuses consumer mailboxes", () => {
		for (const d of ["gmail.com", "me.com", "outlook.com", "proton.me", "icloud.com", "yahoo.co.uk"]) {
			expect(classifyDomain(d).kind, d).toBe("free_mail");
		}
	});

	it("refuses our own domains, which dogfooding puts in the same table as customers", () => {
		expect(classifyDomain("lettertrace.com").kind).toBe("internal");
		expect(classifyDomain("letterstory.com").kind).toBe("internal");
		expect(classifyDomain("letter.company").kind).toBe("internal");
	});

	it("separates internal from free_mail rather than lumping both into one bucket", () => {
		// They are excluded for different reasons and an operator needs to tell
		// them apart: one is a person, the other is us.
		expect(classifyDomain("gmail.com").kind).not.toBe(classifyDomain("lettertrace.com").kind);
	});

	it("rejects reserved TLDs — fixtures and probes, never real identities", () => {
		expect(classifyDomain("acme-corp.example").kind).toBe("unknown");
		expect(classifyDomain("probe.invalid").kind).toBe("unknown");
		expect(classifyDomain("foo.test").kind).toBe("unknown");
	});

	it("rejects things that are not domains at all", () => {
		expect(classifyDomain("").kind).toBe("unknown");
		expect(classifyDomain("   ").kind).toBe("unknown");
		expect(classifyDomain("localhost").kind).toBe("unknown");
		expect(classifyDomain("acme").kind).toBe("unknown");
		expect(classifyDomain("192.168.1.1").kind).toBe("unknown");
		expect(classifyDomain("jane@acme.com").kind).toBe("unknown");
		expect(classifyDomain("acme.com/path").kind).toBe("unknown");
	});

	it("normalises case, whitespace and a trailing root dot before matching", () => {
		// A fully-qualified name and a shouted one must not slip past the list.
		expect(classifyDomain("GMAIL.COM").kind).toBe("free_mail");
		expect(classifyDomain("  gmail.com  ").kind).toBe("free_mail");
		expect(classifyDomain("gmail.com.").kind).toBe("free_mail");
		expect(classifyDomain("LetterTrace.com").kind).toBe("internal");
	});

	it("gives a reason for every exclusion, not just a verdict", () => {
		// An operator looking at the bucket has to be able to tell why a domain
		// is there without reading this file.
		for (const d of ["gmail.com", "lettertrace.com", "probe.invalid", ""]) {
			expect(classifyDomain(d).reason, d).toBeTruthy();
		}
	});

	// The default is generous by design: bucketing every unrecognised domain
	// would make the classifier useless, since real customers are exactly the
	// domains no list can enumerate.
	it("defaults an unrecognised domain to company rather than to the bucket", () => {
		expect(classifyDomain("some-startup-nobody-has-heard-of.io").kind).toBe("company");
	});
});

describe("isAttributable", () => {
	it("admits only companies", () => {
		expect(isAttributable("tenevents.com")).toBe(true);
		expect(isAttributable("gmail.com")).toBe(false);
		expect(isAttributable("lettertrace.com")).toBe(false);
		expect(isAttributable("probe.invalid")).toBe(false);
	});
});

describe("partitionDomains", () => {
	it("splits real observations into attributable and explained-away", () => {
		// Exactly what the first hour of live collection produced, plus our own
		// domain and a probe.
		const observed = [
			"tenevents.com",
			"snappykraken.com",
			"gmail.com",
			"globex.com",
			"k9sportsnation.com",
			"pricesmart.com",
			"lettertrace.com",
			"probe.invalid",
		];

		const { attributable, excluded } = partitionDomains(observed);

		expect(attributable).toEqual([
			"tenevents.com",
			"snappykraken.com",
			"globex.com",
			"k9sportsnation.com",
			"pricesmart.com",
		]);
		expect(excluded.map((e) => e.domain)).toEqual(["gmail.com", "lettertrace.com", "probe.invalid"]);
		expect(excluded.map((e) => e.kind)).toEqual(["free_mail", "internal", "unknown"]);
	});

	it("keeps every input, so a count can never silently shrink", () => {
		const observed = ["a.com", "gmail.com", "", "lettertrace.com"];
		const { attributable, excluded } = partitionDomains(observed);
		expect(attributable.length + excluded.length).toBe(observed.length);
	});

	it("handles an empty set without special-casing", () => {
		expect(partitionDomains([])).toEqual({ attributable: [], excluded: [] });
	});
});
