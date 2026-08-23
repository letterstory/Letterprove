import { describe, expect, it } from "vitest";
import type { DomainTierRow, TierStatus } from "@/lib/tiers/report";
import { eventsOf, isActionable, matchesQuery, sortRows } from "./filter";

function row(domain: string, status: TierStatus, events = 0, customer: string | null = null): DomainTierRow {
	return {
		domain,
		kind: "company",
		sessions: events,
		signups: 0,
		logins: 0,
		customer,
		assertedTier: null,
		earnedTier: null,
		consent: null,
		status,
		detail: "",
	} as DomainTierRow;
}

describe("isActionable", () => {
	it("counts the two statuses a person can move from this page", () => {
		expect(isActionable("no-customer-record")).toBe(true);
		expect(isActionable("consent-withheld")).toBe(true);
	});

	it("excludes not-attributable however loud it is", () => {
		// The real case this guards: gmail.com carries the highest event count on
		// lettertrace and can never become a published customer. Treating volume
		// as importance is what buried the one actionable domain.
		expect(isActionable("not-attributable")).toBe(false);
	});

	it("excludes already-published and no-evidence rows", () => {
		expect(isActionable("published")).toBe(false);
		expect(isActionable("no-observation")).toBe(false);
	});
});

describe("sortRows", () => {
	it("puts an actionable domain above a louder unpublishable one", () => {
		const sorted = sortRows([
			row("gmail.com", "not-attributable", 109),
			row("acme.com", "no-customer-record", 9),
		]);

		expect(sorted.map((r) => r.domain)).toEqual(["acme.com", "gmail.com"]);
	});

	it("orders by volume within the same status", () => {
		const sorted = sortRows([
			row("small.com", "no-customer-record", 2),
			row("big.com", "no-customer-record", 40),
		]);

		expect(sorted.map((r) => r.domain)).toEqual(["big.com", "small.com"]);
	});

	it("breaks a full tie by domain, so equal rows never reshuffle between renders", () => {
		const a = sortRows([row("b.com", "published", 5), row("a.com", "published", 5)]);
		const b = sortRows([row("a.com", "published", 5), row("b.com", "published", 5)]);

		expect(a.map((r) => r.domain)).toEqual(["a.com", "b.com"]);
		expect(b.map((r) => r.domain)).toEqual(["a.com", "b.com"]);
	});

	it("does not mutate the caller's array — the report is shared across renders", () => {
		const input = [row("b.com", "not-attributable", 1), row("a.com", "no-customer-record", 1)];
		const before = input.map((r) => r.domain);

		sortRows(input);

		expect(input.map((r) => r.domain)).toEqual(before);
	});
});

describe("matchesQuery", () => {
	it("matches on domain", () => {
		expect(matchesQuery(row("acme.com", "no-customer-record"), "acme")).toBe(true);
	});

	it("matches on the customer record's name", () => {
		expect(matchesQuery(row("x.com", "published", 0, "acme-corp"), "acme")).toBe(true);
	});

	it("matches on the status label a person actually sees, not the internal slug", () => {
		expect(matchesQuery(row("x.com", "consent-withheld"), "awaiting consent")).toBe(true);
	});

	it("returns everything for an empty query", () => {
		expect(matchesQuery(row("x.com", "published"), "")).toBe(true);
	});

	it("does not match an unrelated term", () => {
		expect(matchesQuery(row("acme.com", "no-customer-record"), "gmail")).toBe(false);
	});
});

describe("eventsOf", () => {
	it("sums all three event kinds", () => {
		const r = { ...row("x.com", "published"), sessions: 5, signups: 3, logins: 1 };
		expect(eventsOf(r)).toBe(9);
	});
});
