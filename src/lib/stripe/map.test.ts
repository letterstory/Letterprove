import { describe, expect, it } from "vitest";
import { mapPayments, type StripeSubscriptionLike } from "./map";
import type { PaidInvoiceIndex, SubscriptionPayments } from "./fetch";

/** A fixed instant, so the lapsed-payment rule is tested rather than the clock. */
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const FIRST_SETTLED = Date.parse("2026-01-15T00:00:00.000Z") / 1000;
const LAST_SETTLED = Date.parse("2026-05-20T00:00:00.000Z") / 1000;

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

/** Money that really moved for each of these subscriptions. */
function settled(ids: string[], over: Partial<SubscriptionPayments> = {}): PaidInvoiceIndex {
	return new Map(
		ids.map((id) => [
			id,
			{ firstSettledAt: FIRST_SETTLED, lastSettledAt: LAST_SETTLED, settledCount: 4, markedPaidCount: 0, ...over },
		])
	);
}

const PAID = settled(["sub_1"]);
const OBSERVED = new Set(["acme.com", "globex.com"]);
const AT_NOW = { now: NOW };

describe("mapPayments — the join", () => {
	it("attaches a paying subscription to the observed domain", () => {
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, PAID, AT_NOW);

		expect(unmatched).toEqual([]);
		expect(matched).toEqual([
			{
				domain: "acme.com",
				// The first invoice that SETTLED, not the subscription's start
				// date. start_date here is March; the money started in January.
				since: "2026-01-15T00:00:00.000Z",
				currency: "usd",
				monthlyAmount: 400000,
				subscriptionCount: 1,
			},
		]);
	});

	it("sums several subscriptions for one domain and keeps the earliest settled invoice", () => {
		const paid: PaidInvoiceIndex = new Map([
			...settled(["sub_a"], { firstSettledAt: Date.parse("2026-05-01T00:00:00Z") / 1000 }),
			...settled(["sub_b"], { firstSettledAt: Date.parse("2026-01-01T00:00:00Z") / 1000 }),
		]);

		const { matched } = mapPayments(
			[sub({ id: "sub_a", amount: 100000 }), sub({ id: "sub_b", amount: 50000 })],
			OBSERVED,
			paid,
			AT_NOW
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
		const { matched } = mapPayments([sub({ amount: 1200000, interval: "year" })], OBSERVED, PAID, AT_NOW);

		expect(matched[0].monthlyAmount).toBe(100000);
	});

	it("normalises the other intervals in the same direction", () => {
		// Every one of these must come out LARGER than the per-interval amount,
		// because the interval is shorter than a month. That is the check the
		// yearly bug would have failed in reverse.
		const recent = settled(["sub_1"], { lastSettledAt: NOW / 1000 - 60 * 60 });

		const daily = mapPayments([sub({ amount: 1000, interval: "day" })], OBSERVED, recent, AT_NOW);
		expect(daily.matched[0].monthlyAmount).toBe(30000);

		const weekly = mapPayments([sub({ amount: 1000, interval: "week" })], OBSERVED, recent, AT_NOW);
		expect(weekly.matched[0].monthlyAmount).toBe(4345);

		const monthly = mapPayments([sub({ amount: 1000, interval: "month" })], OBSERVED, recent, AT_NOW);
		expect(monthly.matched[0].monthlyAmount).toBe(1000);
	});
});

describe("mapPayments — what does not count as payment", () => {
	it("excludes a trial, which is not a paying customer", () => {
		// Tier 3's whole claim is that money corroborates usage. A trial is a
		// relationship, not a payment.
		expect(mapPayments([sub({ status: "trialing" })], OBSERVED, PAID, AT_NOW).matched).toEqual([]);
	});

	it("excludes past_due, where the relationship exists but the money has not landed", () => {
		expect(mapPayments([sub({ status: "past_due" })], OBSERVED, PAID, AT_NOW).matched).toEqual([]);
	});

	it("excludes canceled and incomplete subscriptions", () => {
		for (const status of ["canceled", "incomplete", "incomplete_expired", "unpaid", "paused"]) {
			expect(mapPayments([sub({ status })], OBSERVED, PAID, AT_NOW).matched).toEqual([]);
		}
	});
});

describe("mapPayments — money has to have actually moved", () => {
	/*
	 * The hole these close. `active` is a status the account owner configures,
	 * not a receipt: a $0 recurring price reaches it instantly with no payment
	 * method attached, and so does a 100%-off coupon. For as long as this file
	 * scored subscriptions alone, a signed tier-3 attestation naming any
	 * company you like cost a vendor ten minutes and nothing at all.
	 */

	it("refuses a $0 recurring price, which reaches active for free", () => {
		const { matched, unmatched } = mapPayments([sub({ amount: 0 })], OBSERVED, PAID, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched).toEqual([{ subscriptionId: "sub_1", reason: "zero_amount", domain: "acme.com" }]);
	});

	it("refuses a subscription with no readable price or interval", () => {
		// It used to be counted toward subscriptionCount while contributing
		// nothing to the amount, so a domain could be published as paying on
		// the strength of a subscription we could not read at all.
		const { matched, unmatched } = mapPayments(
			[sub({ amount: null, interval: null })],
			OBSERVED,
			PAID,
			AT_NOW
		);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_recurring_amount");
	});

	it("refuses an active subscription nothing has ever settled against", () => {
		// The 100%-off coupon shape: a real price, a real subscription, and no
		// invoice that ever collected a penny.
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, new Map(), AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_settled_invoice");
	});

	it("refuses an invoice marked paid with no processor behind it", () => {
		// `paid_out_of_band` is the vendor ticking a box in their own
		// dashboard. It is a vendor assertion wearing a third party's badge,
		// and named separately so the vendor is told which rule refused it.
		const outOfBand = settled(["sub_1"], {
			settledCount: 0,
			markedPaidCount: 2,
			firstSettledAt: null,
			lastSettledAt: null,
		});
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, outOfBand, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("paid_out_of_band");
	});

	it("refuses a subscription that stopped collecting, however active it still looks", () => {
		// send_invoice collection with a long due date keeps a subscription
		// active indefinitely. One payment in 2025 must not go on publishing
		// "pays us" in the present tense.
		const lapsed = settled(["sub_1"], { lastSettledAt: Date.parse("2026-01-20T00:00:00Z") / 1000 });
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, lapsed, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("payment_lapsed");
	});

	it("gives an annual subscription a year's worth of room before calling it lapsed", () => {
		// The same four-month-old payment that fails for a monthly subscription
		// is exactly what a healthy annual one looks like.
		const lapsed = settled(["sub_1"], { lastSettledAt: Date.parse("2026-01-20T00:00:00Z") / 1000 });
		const { matched } = mapPayments(
			[sub({ amount: 1200000, interval: "year" })],
			OBSERVED,
			lapsed,
			AT_NOW
		);

		expect(matched[0].monthlyAmount).toBe(100000);
	});

	it("refuses a sum that rounds to nothing rather than publishing a zero", () => {
		// A fraction of a minor unit per month is not a payment, and
		// `contract_monthly: 0` inside a signed body reads as "pays nothing".
		const { matched, unmatched } = mapPayments(
			[sub({ amount: 1, interval: "year" })],
			OBSERVED,
			PAID,
			AT_NOW
		);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("zero_amount");
	});
});

describe("mapPayments — unmatched payments are surfaced, never guessed at", () => {
	it("reports a customer with no email", () => {
		const { matched, unmatched } = mapPayments([sub({ customerEmail: null })], OBSERVED, PAID, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched).toEqual([{ subscriptionId: "sub_1", reason: "no_email", domain: null }]);
	});

	it("reports a personal mailbox rather than treating it as a company", () => {
		// Small accounts really do pay from gmail. That is billing evidence
		// about a person, and it cannot name a company.
		const { unmatched } = mapPayments([sub({ customerEmail: "someone@gmail.com" })], OBSERVED, PAID, AT_NOW);

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
			[sub({ customerEmail: "ap@holdings-parent.com" })],
			OBSERVED,
			PAID,
			AT_NOW
		);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_observed_traffic");
		expect(unmatched[0].domain).toBe("holdings-parent.com");
	});

	it("refuses to sum one domain paying in two currencies", () => {
		// Summing would mean inventing an exchange rate, and that invented
		// number would end up inside a signed attestation.
		const { matched, unmatched } = mapPayments(
			[sub({ id: "sub_a", currency: "usd" }), sub({ id: "sub_b", currency: "eur" })],
			OBSERVED,
			settled(["sub_a", "sub_b"]),
			AT_NOW
		);

		expect(matched).toEqual([]);
		expect(unmatched.map((u) => u.reason)).toEqual(["currency_conflict", "currency_conflict"]);
	});

	it("handles a malformed email without crashing", () => {
		for (const bad of ["no-at-sign", "@leading.com", "trailing@"]) {
			const { unmatched } = mapPayments([sub({ customerEmail: bad })], OBSERVED, PAID, AT_NOW);
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
		const { matched, unmatched } = mapPayments([sub()], new Set(), PAID, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_observed_traffic");
	});

	it("fails CLOSED when the settled-invoice index is empty", () => {
		// The same lesson applied to the corroboration read. An empty map is
		// what a refused or failed invoice fetch produces, and it must mean
		// "nothing is corroborated" rather than "skip the check" — otherwise a
		// vendor gets the old, forgeable behaviour back by breaking one
		// permission on their key.
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, new Map(), AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_settled_invoice");
	});

	it("publishes unobserved billing only when explicitly asked to", () => {
		const { matched } = mapPayments([sub({ customerEmail: "ap@anywhere.com" })], new Set(), PAID, {
			...AT_NOW,
			allowUnobserved: true,
		});

		expect(matched[0].domain).toBe("anywhere.com");
	});

	it("lowercases and trims the domain, so one company is not two", () => {
		const { matched } = mapPayments([sub({ customerEmail: "Billing@ACME.com " })], OBSERVED, PAID, AT_NOW);

		expect(matched[0].domain).toBe("acme.com");
	});

	it("returns domains in a stable order regardless of input order", () => {
		const paid = settled(["1", "2"]);
		const a = mapPayments(
			[sub({ id: "1" }), sub({ id: "2", customerEmail: "b@globex.com" })],
			OBSERVED,
			paid,
			AT_NOW
		);
		const b = mapPayments(
			[sub({ id: "2", customerEmail: "b@globex.com" }), sub({ id: "1" })],
			OBSERVED,
			paid,
			AT_NOW
		);

		expect(a.matched.map((m) => m.domain)).toEqual(["acme.com", "globex.com"]);
		expect(b.matched.map((m) => m.domain)).toEqual(a.matched.map((m) => m.domain));
	});

	it("counts only the subscriptions that survived, so the count cannot overstate", () => {
		const { matched } = mapPayments(
			[sub({ amount: null, interval: null }), sub({ id: "sub_b", amount: 25000 })],
			OBSERVED,
			settled(["sub_1", "sub_b"]),
			AT_NOW
		);

		expect(matched[0].monthlyAmount).toBe(25000);
		expect(matched[0].subscriptionCount).toBe(1);
	});

	it("returns empty for no subscriptions at all", () => {
		expect(mapPayments([], OBSERVED, PAID, AT_NOW)).toEqual({ matched: [], unmatched: [] });
	});
});
