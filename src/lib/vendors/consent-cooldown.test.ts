import { describe, expect, it } from "vitest";
import { CONSENT_REASK_COOLDOWN_MS, consentCooldown } from "./consent-cooldown";

/**
 * The cooldown is the only thing standing between a customer's "no" and a
 * vendor re-sending the same request every day. It is deliberately a window
 * rather than a permanent block, so both ends of that window matter: too
 * eager and the decline means nothing, too permanent and a customer who
 * declined once could never later agree.
 *
 * `now` is injected throughout rather than mocking the clock, so these sit
 * exactly on the boundary without sleeping.
 */

const DECLINED = "2026-08-01T12:00:00.000Z";
const at = (ms: number) => new Date(new Date(DECLINED).getTime() + ms);

describe("consentCooldown", () => {
	it("does not block a customer who has never declined", () => {
		expect(consentCooldown(null)).toBeNull();
		expect(consentCooldown(undefined)).toBeNull();
	});

	it("blocks immediately after a decline", () => {
		const cooldown = consentCooldown(DECLINED, at(1000));

		expect(cooldown).not.toBeNull();
		expect(cooldown!.declinedAt).toBe(DECLINED);
		expect(cooldown!.canAskAgainAt).toBe(new Date(new Date(DECLINED).getTime() + CONSENT_REASK_COOLDOWN_MS).toISOString());
	});

	it("still blocks one millisecond before the window closes", () => {
		expect(consentCooldown(DECLINED, at(CONSENT_REASK_COOLDOWN_MS - 1))).not.toBeNull();
	});

	it("stops blocking exactly when the window closes", () => {
		// The boundary is inclusive on the "allowed" side: at exactly 30 days the
		// vendor may ask. Off-by-one here is the difference between a rule and an
		// arbitrary extra day.
		expect(consentCooldown(DECLINED, at(CONSENT_REASK_COOLDOWN_MS))).toBeNull();
	});

	it("stops blocking well after the window", () => {
		expect(consentCooldown(DECLINED, at(CONSENT_REASK_COOLDOWN_MS * 3))).toBeNull();
	});

	/*
	 * The column is written only by recordConsentDecision, with an ISO string,
	 * so the reachable cause of garbage is corruption. Failing open on a re-ask
	 * is the milder failure — the alternative is a customer row nobody can ever
	 * request consent for again, with no way for the vendor to see why.
	 */
	it("fails open on a malformed timestamp rather than blocking forever", () => {
		expect(consentCooldown("not a date")).toBeNull();
		expect(consentCooldown("")).toBeNull();
	});

	it("is 30 days", () => {
		// Pinned deliberately. This number is a product decision about how often
		// a vendor may ask someone who said no — changing it should be a visible
		// edit to a test that says so, not an incidental tweak to a constant.
		expect(CONSENT_REASK_COOLDOWN_MS).toBe(30 * 24 * 60 * 60 * 1000);
	});
});
