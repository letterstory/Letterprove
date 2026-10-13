import { describe, expect, it } from "vitest";
import { mapPayments, type StripeSubscriptionLike } from "./map";
import type { PaidInvoiceIndex, SettledInvoice } from "./fetch";

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
		interval: "month",
		productIds: ["prod_core"],
		...overrides,
	};
}

let invoiceSeq = 0;
function inv(overrides: Partial<SettledInvoice> = {}): SettledInvoice {
	return {
		id: `in_${++invoiceSeq}`,
		paidAt: LAST_SETTLED,
		amountPaid: 400000,
		currency: "usd",
		customerEmail: "billing@acme.com",
		billingReason: "subscription_cycle",
		lines: [{ product: "prod_core", net: overrides.amountPaid ?? 400000 }],
		linesComplete: true,
		...overrides,
	};
}

/** Two settled invoices per subscription: the first in January, the latest in May. */
function settled(ids: string[], latest: Partial<SettledInvoice> = {}, first: Partial<SettledInvoice> = {}): PaidInvoiceIndex {
	return new Map(
		ids.map((id) => [
			id,
			{
				settled: [inv({ paidAt: FIRST_SETTLED, billingReason: "subscription_create", ...latest, ...first }), inv(latest)],
				markedPaidCount: 0,
			},
		]),
	);
}

const PAID = settled(["sub_1"]);
const OBSERVED = new Set(["acme.com", "globex.com", "bigco.com"]);
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
			...settled(["sub_a"], { amountPaid: 100000 }, { paidAt: Date.parse("2026-05-01T00:00:00Z") / 1000 }),
			...settled(["sub_b"], { amountPaid: 50000 }, { paidAt: Date.parse("2026-01-01T00:00:00Z") / 1000 }),
		]);

		const { matched } = mapPayments([sub({ id: "sub_a" }), sub({ id: "sub_b" })], OBSERVED, paid, AT_NOW);

		expect(matched[0].monthlyAmount).toBe(150000);
		expect(matched[0].since).toBe("2026-01-01T00:00:00.000Z");
		expect(matched[0].subscriptionCount).toBe(2);
	});

	it("normalises a yearly invoice to a monthly figure", () => {
		// Regression guard. The first version multiplied by months instead of
		// dividing, publishing annual contracts at twelve times their value.
		const { matched } = mapPayments([sub({ interval: "year" })], OBSERVED, settled(["sub_1"], { amountPaid: 1200000 }), AT_NOW);

		expect(matched[0].monthlyAmount).toBe(100000);
	});

	it("normalises the other intervals in the same direction", () => {
		const recent = settled(["sub_1"], { amountPaid: 1000, paidAt: NOW / 1000 - 60 * 60 });

		expect(mapPayments([sub({ interval: "day" })], OBSERVED, recent, AT_NOW).matched[0].monthlyAmount).toBe(30000);
		expect(mapPayments([sub({ interval: "week" })], OBSERVED, recent, AT_NOW).matched[0].monthlyAmount).toBe(4345);
		expect(mapPayments([sub({ interval: "month" })], OBSERVED, recent, AT_NOW).matched[0].monthlyAmount).toBe(1000);
	});
});

describe("mapPayments — the amount is what was paid, not the list price", () => {
	it("publishes what settled after a coupon, not the plan's sticker price", () => {
		// The hole: a $50k/month price with a 99.99% coupon, paid at $5, was
		// signed as contract_monthly 5,000,000. The invoice says $5 moved.
		const coupon = settled(["sub_1"], { amountPaid: 500, lines: [{ product: "prod_core", net: 500 }] });
		const { matched } = mapPayments([sub()], OBSERVED, coupon, AT_NOW);

		expect(matched[0].monthlyAmount).toBe(500);
	});

	it("uses the latest full-period invoice, not a mid-period proration", () => {
		const paid: PaidInvoiceIndex = new Map([
			[
				"sub_1",
				{
					settled: [
						inv({ paidAt: FIRST_SETTLED, amountPaid: 400000, billingReason: "subscription_create" }),
						inv({ paidAt: LAST_SETTLED, amountPaid: 1234, billingReason: "subscription_update" }),
					],
					markedPaidCount: 0,
				},
			],
		]);

		expect(mapPayments([sub()], OBSERVED, paid, AT_NOW).matched[0].monthlyAmount).toBe(400000);
	});
});

describe("mapPayments — the billed identity comes from the invoices", () => {
	it("refuses a subscription whose invoices were billed to different domains", () => {
		// The attack: change a small payer's email to cto@bigco.com. The old
		// invoices still carry billing@acme.com, frozen when they settled, so
		// the payment cannot quietly become bigco's.
		const moved = settled(["sub_1"], { customerEmail: "cto@bigco.com" }, { customerEmail: "billing@acme.com" });
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, moved, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched).toEqual([{ subscriptionId: "sub_1", reason: "email_changed", domain: null }]);
	});

	it("accepts different mailboxes on the same domain", () => {
		const sameDomain = settled(["sub_1"], { customerEmail: "ap@acme.com" }, { customerEmail: "billing@acme.com" });

		expect(mapPayments([sub()], OBSERVED, sameDomain, AT_NOW).matched[0].domain).toBe("acme.com");
	});

	it("reports invoices with no frozen email", () => {
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, settled(["sub_1"], { customerEmail: null }), AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched).toEqual([{ subscriptionId: "sub_1", reason: "no_email", domain: null }]);
	});

	it("calls a mix of emailed and email-less invoices a change, not a match", () => {
		const mixed = settled(["sub_1"], { customerEmail: "billing@acme.com" }, { customerEmail: null });

		expect(mapPayments([sub()], OBSERVED, mixed, AT_NOW).unmatched[0].reason).toBe("email_changed");
	});
});

describe("mapPayments — product scope", () => {
	const SCOPE = { ...AT_NOW, productScope: new Set(["prod_core"]) };

	it("skips a subscription to a product outside the vendor's scope", () => {
		// One Stripe account, many products. A customer of the vendor's other
		// product is not evidence for this one.
		const { matched, unmatched } = mapPayments([sub({ productIds: ["prod_other"] })], OBSERVED, PAID, SCOPE);

		expect(matched).toEqual([]);
		expect(unmatched).toEqual([{ subscriptionId: "sub_1", reason: "out_of_scope", domain: null }]);
	});

	it("counts only the in-scope share of a mixed invoice", () => {
		const mixed = settled(["sub_1"], {
			amountPaid: 90000,
			lines: [
				{ product: "prod_core", net: 30000 },
				{ product: "prod_other", net: 70000 },
			],
		});
		const { matched } = mapPayments([sub({ productIds: ["prod_core", "prod_other"] })], OBSERVED, mixed, SCOPE);

		// 30% of the lines, applied to the 90,000 that actually settled.
		expect(matched[0].monthlyAmount).toBe(27000);
	});

	it("counts nothing from an invoice whose lines Stripe truncated", () => {
		const truncated = settled(["sub_1"], { linesComplete: false }, { linesComplete: false });
		const { unmatched } = mapPayments([sub()], OBSERVED, truncated, SCOPE);

		expect(unmatched[0].reason).toBe("no_settled_invoice");
	});

	it("treats an empty scope as every product", () => {
		const { matched } = mapPayments([sub({ productIds: ["prod_other"] })], OBSERVED, PAID, { ...AT_NOW, productScope: new Set() });

		expect(matched).toHaveLength(1);
	});
});

describe("mapPayments — what does not count as payment", () => {
	it("excludes a trial, which is not a paying customer", () => {
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

	it("refuses a subscription with no readable interval", () => {
		const { matched, unmatched } = mapPayments([sub({ interval: null })], OBSERVED, PAID, AT_NOW);

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
		const outOfBand: PaidInvoiceIndex = new Map([["sub_1", { settled: [], markedPaidCount: 2 }]]);
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, outOfBand, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("paid_out_of_band");
	});

	it("refuses a subscription that stopped collecting, however active it still looks", () => {
		const lapsed = settled(["sub_1"], { paidAt: Date.parse("2026-01-20T00:00:00Z") / 1000 });
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, lapsed, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("payment_lapsed");
	});

	it("gives an annual subscription a year's worth of room before calling it lapsed", () => {
		const lapsed = settled(["sub_1"], { amountPaid: 1200000, paidAt: Date.parse("2026-01-20T00:00:00Z") / 1000 });
		const { matched } = mapPayments([sub({ interval: "year" })], OBSERVED, lapsed, AT_NOW);

		expect(matched[0].monthlyAmount).toBe(100000);
	});

	it("refuses a sum that rounds to nothing rather than publishing a zero", () => {
		const { matched, unmatched } = mapPayments([sub({ interval: "year" })], OBSERVED, settled(["sub_1"], { amountPaid: 1 }), AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("zero_amount");
	});
});

describe("mapPayments — unmatched payments are surfaced, never guessed at", () => {
	it("reports a personal mailbox rather than treating it as a company", () => {
		const { unmatched } = mapPayments([sub()], OBSERVED, settled(["sub_1"], { customerEmail: "someone@gmail.com" }), AT_NOW);

		expect(unmatched[0]).toEqual({ subscriptionId: "sub_1", reason: "not_a_company", domain: "gmail.com" });
	});

	it("reports a company we have never observed, instead of publishing it", () => {
		const { matched, unmatched } = mapPayments(
			[sub()],
			OBSERVED,
			settled(["sub_1"], { customerEmail: "ap@holdings-parent.com" }),
			AT_NOW,
		);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_observed_traffic");
		expect(unmatched[0].domain).toBe("holdings-parent.com");
	});

	it("refuses to sum one domain paying in two currencies", () => {
		const paid: PaidInvoiceIndex = new Map([...settled(["sub_a"], { currency: "usd" }), ...settled(["sub_b"], { currency: "eur" })]);
		const { matched, unmatched } = mapPayments([sub({ id: "sub_a" }), sub({ id: "sub_b" })], OBSERVED, paid, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched.map((u) => u.reason)).toEqual(["currency_conflict", "currency_conflict"]);
	});

	it("handles a malformed email without crashing", () => {
		for (const bad of ["no-at-sign", "@leading.com", "trailing@"]) {
			const { unmatched } = mapPayments([sub()], OBSERVED, settled(["sub_1"], { customerEmail: bad }), AT_NOW);
			expect(unmatched[0].reason).toBe("no_email");
		}
	});
});

describe("mapPayments — determinism and edges", () => {
	it("fails CLOSED when there are no observed domains", () => {
		const { matched, unmatched } = mapPayments([sub()], new Set(), PAID, AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_observed_traffic");
	});

	it("fails CLOSED when the settled-invoice index is empty", () => {
		const { matched, unmatched } = mapPayments([sub()], OBSERVED, new Map(), AT_NOW);

		expect(matched).toEqual([]);
		expect(unmatched[0].reason).toBe("no_settled_invoice");
	});

	it("publishes unobserved billing only when explicitly asked to", () => {
		const { matched } = mapPayments([sub()], new Set(), settled(["sub_1"], { customerEmail: "ap@anywhere.com" }), {
			...AT_NOW,
			allowUnobserved: true,
		});

		expect(matched[0].domain).toBe("anywhere.com");
	});

	it("lowercases and trims the domain, so one company is not two", () => {
		const { matched } = mapPayments([sub()], OBSERVED, settled(["sub_1"], { customerEmail: "Billing@ACME.com " }), AT_NOW);

		expect(matched[0].domain).toBe("acme.com");
	});

	it("returns domains in a stable order regardless of input order", () => {
		const paid: PaidInvoiceIndex = new Map([...settled(["1"]), ...settled(["2"], { customerEmail: "b@globex.com" })]);
		const a = mapPayments([sub({ id: "1" }), sub({ id: "2" })], OBSERVED, paid, AT_NOW);
		const b = mapPayments([sub({ id: "2" }), sub({ id: "1" })], OBSERVED, paid, AT_NOW);

		expect(a.matched.map((m) => m.domain)).toEqual(["acme.com", "globex.com"]);
		expect(b.matched.map((m) => m.domain)).toEqual(a.matched.map((m) => m.domain));
	});

	it("counts only the subscriptions that survived, so the count cannot overstate", () => {
		const { matched } = mapPayments(
			[sub({ interval: null }), sub({ id: "sub_b" })],
			OBSERVED,
			settled(["sub_1", "sub_b"], { amountPaid: 25000 }),
			AT_NOW,
		);

		expect(matched[0].monthlyAmount).toBe(25000);
		expect(matched[0].subscriptionCount).toBe(1);
	});

	it("returns empty for no subscriptions at all", () => {
		expect(mapPayments([], OBSERVED, PAID, AT_NOW)).toEqual({ matched: [], unmatched: [] });
	});
});
