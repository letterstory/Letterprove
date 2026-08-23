import { describe, expect, it } from "vitest";
import { mapPayments, type StripeSubscriptionLike } from "./map";

function sub(overrides: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike {
	return {
		id: "sub_1",
		status: "active",
		start_date: Date.parse("2026-03-01T00:00:00.000Z") / 1000,
		currency: "usd",
		amount: 400000,
		interval: "month",
		customerEmail: "billing@acme.com",
		...overrides,
	};
}

const OBSERVED = new Set(["acme.com", "globex.com"]);

describe("mapPayments — the join", () => {
	it("attaches a paying subscription to the observed domain", () => {
		const { matched, unmatched } = mapPayments([sub()], OBSERVED);

		expect(unmatched).toEqual([]);
		expect(matched).toEqual([
			{
				domain: "acme.com",
				since: "2026-03-01T00:00:00.000Z",
				currency: "usd",
				monthlyAmount: 400000,
				subscriptionCount: 1,
			},
		]);
	});

	it("sums several subscriptions for one domain and keeps the earliest start", () => {
		const { matched } = mapPayments(
			[
				sub({ id: "sub_a", amount: 100000, start_date: Date.parse("2026-05-01T00:00:00Z") / 1000 }),
				sub({ id: "sub_b", amount: 50000, start_date: Date.parse("2026-01-01T00:00:00Z") / 1000 }),
			],
			OBSERVED
		);

		expect(matched[0].monthlyAmount).toBe(150000);
		expect(matched[0].since).toBe("2026-01-01T00:00:00.000Z");
		expect(matched[0].subscriptionCount).toBe(2);
	});

	it("normalises a yearly subscription to a monthly figure", () => {
		// Regression guard. The first version multiplied by months instead of
		// dividing, publishing annual contracts at twelve times their value —
		// and annual is the normal enterprise shape, so it would have been
		// wrong on the most important accounts.
		const { matched } = mapPayments([sub({ amount: 1200000, interval: "year" })], OBSERVED);

		expect(matched[0].monthlyAmount).toBe(100000);
	});

	it("normalises the other intervals in the same direction", () => {
		// Every one of these must come out LARGER than the per-interval amount,
		// because the interval is shorter than a month. That is the check the
		// yearly bug would have failed in reverse.
		const daily = mapPayments([sub({ amount: 1000, interval: "day" })], OBSERVED);
		expect(daily.matched[0].monthlyAmount).toBe(30000);

		const weekly = mapPayments([sub({ amount: 1000, interval: "week" })], OBSERVED);
		expect(weekly.matched[0].monthlyAmount).toBe(4345);

		const monthly = mapPayments([sub({ amount: 1000, interval: "month" })], OBSERVED);
		expect(monthly.matched[0].monthlyAmount).toBe(1000);
	});
});

describe("mapPayments — what does not count as payment", () => {
	it("excludes a trial, which is not a paying customer", () => {
		// Tier 3's whole claim is that money corroborates usage. A trial is a
		// relationship, not a payment.
		expect(mapPayments([sub({ status: "trialing" })], OBSERVED).matched).toEqual([]);
	});

	it("excludes past_due, where the relationship exists but the money has not landed", () => {
		expect(mapPayments([sub({ status: "past_due" })], OBSERVED).matched).toEqual([]);
	});

	it("excludes canceled and incomplete subscriptions", () => {
		for (const status of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]) {
			expect(mapPayments([sub({ status })], OBSERVED).matched).toEqual([]);
		}
	});
});

describe("mapPayments — unmatched payments are surfaced, never guessed at", () => {
	it("reports a customer with no email", () => {
		const { matched, unmatched } = mapPayments([sub({ customerEmail: null })], OBSERVED);

		expect(matched).toEqual([]);
		expect(unmatched).toEqual([{ subscriptionId: "sub_1", reason: "no_email", domain: null }]);
	});

	it("reports a personal mailbox rather than treating it as a company", () => {
		// Small accounts really do pay from gmail. That is billing evidence
		// about a person, and it cannot name a company.
		const { unmatched } = mapPayments([sub({ customerEmail: "someone@gmail.com" })], OBSERVED);

		expect(unmatched[0]).toEqual({
			subscriptionId: "sub_1",
			reason: "not_a_company",
			domain: "gmail.com",
		});
	});

	it("reports a company we have never observed, instead of publishing it", () => {
		// This is the case that matters most. Payment from a company whose
		// usage we have never seen is evidence about billing, not about usage —
		// publishing it would claim something we did not observe.
		const { matched, unmatched } = mapPayments(
			[sub({ customerEmail: "ap@parent-holdings.com" })],
			OBSERVED
		);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_observed_traffic");
		expect(unmatched[0].domain).toBe("parent-holdings.com");
	});

	it("refuses to sum one domain paying in two currencies", () => {
		// Summing would mean inventing an exchange rate, and that invented
		// number would end up inside a signed attestation.
		const { matched, unmatched } = mapPayments(
			[sub({ id: "sub_a", currency: "usd" }), sub({ id: "sub_b", currency: "eur" })],
			OBSERVED
		);

		expect(matched).toEqual([]);
		expect(unmatched.map((u) => u.reason)).toEqual(["currency_conflict", "currency_conflict"]);
	});

	it("handles a malformed email without crashing", () => {
		for (const bad of ["no-at-sign", "@leading.com", "trailing@"]) {
			const { unmatched } = mapPayments([sub({ customerEmail: bad })], OBSERVED);
			expect(unmatched[0].reason).toBe("not_a_company");
		}
	});
});

describe("mapPayments — determinism and edges", () => {
	it("fails CLOSED when there are no observed domains", () => {
		// The guard that matters most. An empty set is also what a failed
		// database read returns, so emptiness must never mean "skip the check" —
		// otherwise one bad query publishes every payment as corroborated with
		// nothing corroborating it.
		const { matched, unmatched } = mapPayments([sub()], new Set());

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_observed_traffic");
	});

	it("publishes unobserved billing only when explicitly asked to", () => {
		const { matched } = mapPayments([sub({ customerEmail: "ap@anywhere.com" })], new Set(), {
			allowUnobserved: true,
		});

		expect(matched[0].domain).toBe("anywhere.com");
	});

	it("lowercases and trims the domain, so one company is not two", () => {
		const { matched } = mapPayments([sub({ customerEmail: "Billing@ACME.com " })], OBSERVED);

		expect(matched[0].domain).toBe("acme.com");
	});

	it("returns domains in a stable order regardless of input order", () => {
		const a = mapPayments([sub({ id: "1" }), sub({ id: "2", customerEmail: "b@globex.com" })], OBSERVED);
		const b = mapPayments([sub({ id: "2", customerEmail: "b@globex.com" }), sub({ id: "1" })], OBSERVED);

		expect(a.matched.map((m) => m.domain)).toEqual(["acme.com", "globex.com"]);
		expect(b.matched.map((m) => m.domain)).toEqual(a.matched.map((m) => m.domain));
	});

	it("tolerates a subscription with no amount rather than counting it as zero-cost", () => {
		const { matched } = mapPayments(
			[sub({ amount: null, interval: null }), sub({ id: "sub_b", amount: 25000 })],
			OBSERVED
		);

		expect(matched[0].monthlyAmount).toBe(25000);
		expect(matched[0].subscriptionCount).toBe(2);
	});

	it("returns empty for no subscriptions at all", () => {
		expect(mapPayments([], OBSERVED)).toEqual({ matched: [], unmatched: [] });
	});
});
