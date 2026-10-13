import { describe, expect, it } from "vitest";
import { evaluateAccount, overrideOf } from "./account";

const ACCOUNT = { id: "acct_1", domains: ["acme.com"] };

describe("evaluateAccount — the ledger has to be the vendor's", () => {
	it("accepts an account that publishes the vendor's own domain", () => {
		expect(evaluateAccount(ACCOUNT, "acme.com", null)).toEqual({ ok: true, account: ACCOUNT, overridden: false });
	});

	it("matches on the registrable domain, so app.acme.com and billing.acme.com agree", () => {
		expect(evaluateAccount({ id: "acct_1", domains: ["billing.acme.com"] }, "app.acme.com", null).ok).toBe(true);
		expect(evaluateAccount({ id: "acct_1", domains: ["acme.co.uk"] }, "www.acme.co.uk", null).ok).toBe(true);
	});

	it("refuses an account that describes itself as another business", () => {
		const result = evaluateAccount({ id: "acct_9", domains: ["letter.company"] }, "letterstory.com", null);

		expect(result).toMatchObject({ ok: false, error: "stripe_account_domain_mismatch", account: { id: "acct_9" } });
		expect(!result.ok && result.detail).toMatch(/letter\.company.*letterstory\.com/);
	});

	it("refuses an account that publishes no domain at all", () => {
		const result = evaluateAccount({ id: "acct_9", domains: [] }, "acme.com", null);

		expect(!result.ok && result.detail).toMatch(/no domain at all/);
	});

	it("does not match a lookalike that merely ends in the vendor's name", () => {
		expect(evaluateAccount({ id: "acct_9", domains: ["notacme.com"] }, "acme.com", null).ok).toBe(false);
	});

	it("accepts a mismatched account staff approved, by its account id", () => {
		const override = { accountId: "acct_9", at: "2026-10-13T00:00:00Z", by: "staff-user", reason: "Parent company bills" };

		expect(evaluateAccount({ id: "acct_9", domains: ["letter.company"] }, "letterstory.com", override)).toMatchObject({ ok: true, overridden: true });
	});

	it("does not let an override for one account cover a different one", () => {
		// The key can be swapped at any time; the override travels with the
		// account staff looked at, not with the vendor.
		const override = { accountId: "acct_9", at: "2026-10-13T00:00:00Z", by: null, reason: null };

		expect(evaluateAccount({ id: "acct_other", domains: ["elsewhere.com"] }, "letterstory.com", override).ok).toBe(false);
	});
});

describe("overrideOf", () => {
	it("is null unless both the account and the time are set", () => {
		expect(overrideOf({})).toBeNull();
		expect(overrideOf({ stripe_account_override_account_id: "acct_1" })).toBeNull();
		expect(
			overrideOf({ stripe_account_override_account_id: "acct_1", stripe_account_override_at: "t", stripe_account_override_reason: "why" }),
		).toEqual({ accountId: "acct_1", at: "t", by: null, reason: "why" });
	});
});
