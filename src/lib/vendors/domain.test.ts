import { describe, expect, it } from "vitest";
import { hostnameOf, normalizeDomain } from "./domain";

describe("normalizeDomain", () => {
	it("keeps a plain hostname as-is", () => {
		expect(normalizeDomain("acme.com")).toBe("acme.com");
	});

	it("lowercases, because the collector compares lowercase", () => {
		expect(normalizeDomain("ACME.com")).toBe("acme.com");
		expect(normalizeDomain("Acme.COM")).toBe("acme.com");
	});

	it("accepts what people actually paste", () => {
		// This is the exact shape that was stored in production and silently
		// collected nothing: a full URL with scheme and trailing slash.
		expect(normalizeDomain("https://steve-johnson.dev/")).toBe("steve-johnson.dev");
		expect(normalizeDomain("http://acme.com")).toBe("acme.com");
		expect(normalizeDomain("https://acme.com/pricing?utm=x")).toBe("acme.com");
		expect(normalizeDomain("  acme.com  ")).toBe("acme.com");
		expect(normalizeDomain("acme.com.")).toBe("acme.com");
	});

	it("drops the port, matching what the collector compares", () => {
		// `new URL().hostname` has no port, and the collector has always
		// compared against that, so the stored value must not carry one.
		expect(normalizeDomain("acme.com:3000")).toBe("acme.com");
		expect(normalizeDomain("https://acme.com:8443/")).toBe("acme.com");
	});

	it("does NOT strip www, because that is a different origin", () => {
		// The browser sends whichever host actually served the page. Folding
		// www away would recreate the silent mismatch in the other direction.
		expect(normalizeDomain("www.acme.com")).toBe("www.acme.com");
		expect(normalizeDomain("https://www.acme.com/")).toBe("www.acme.com");
	});

	it("keeps subdomains, which are also distinct origins", () => {
		expect(normalizeDomain("app.acme.co.uk")).toBe("app.acme.co.uk");
	});

	it("rejects things that are not hostnames", () => {
		for (const bad of ["", "   ", "my company", "acme", "not a domain", "!!!", "/"]) {
			expect(normalizeDomain(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it("rejects null and undefined without throwing", () => {
		expect(normalizeDomain(null)).toBeNull();
		expect(normalizeDomain(undefined)).toBeNull();
	});

	it("allows bare localhost for local development", () => {
		expect(normalizeDomain("localhost")).toBe("localhost");
		expect(normalizeDomain("http://localhost:9100")).toBe("localhost");
	});

	it("takes the host, not the credentials, from a userinfo URL", () => {
		// https://acme.com@evil.com resolves to evil.com — the host is what the
		// browser reports as Origin, so that is what must be stored.
		expect(normalizeDomain("https://acme.com@evil.com/")).toBe("evil.com");
	});

	it("is idempotent — normalising twice changes nothing", () => {
		for (const input of ["ACME.com", "https://www.acme.com:443/x", "acme.com."]) {
			const once = normalizeDomain(input)!;
			expect(normalizeDomain(once)).toBe(once);
		}
	});
});

describe("hostnameOf", () => {
	it("derives the same value the collector pins against", () => {
		// The collector reads the Origin header, which is always scheme+host
		// (+port). Whatever it derives must equal a normalised stored domain.
		const cases: [string, string][] = [
			["https://acme.com", "acme.com"],
			["http://acme.com:3000", "acme.com"],
			["https://www.acme.com", "www.acme.com"],
		];
		for (const [origin, expected] of cases) {
			expect(hostnameOf(origin)).toBe(expected);
			expect(normalizeDomain(expected)).toBe(hostnameOf(origin));
		}
	});

	it("returns null for a missing or unparseable origin", () => {
		expect(hostnameOf(null)).toBeNull();
		expect(hostnameOf("")).toBeNull();
		expect(hostnameOf("null")).toBeNull(); // the literal Origin: null
	});
});

describe("the collector and signup agree", () => {
	it("a domain accepted at signup matches the Origin a browser would send", () => {
		// The regression this whole module exists to prevent: signup stores X,
		// the browser sends Y, and X !== Y forever with no error surfaced.
		const typedAtSignup = "https://Steve-Johnson.dev/";
		const stored = normalizeDomain(typedAtSignup);
		const sentByBrowser = hostnameOf("https://steve-johnson.dev");
		expect(stored).toBe(sentByBrowser);
	});
});
