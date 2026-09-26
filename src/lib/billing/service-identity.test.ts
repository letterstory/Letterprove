import { afterEach, describe, expect, it } from "vitest";
import { isAgenticReadBillingService } from "./service-identity";

const CRON_ID = "letterstory-billing-cron";

function withEnv(value: string | undefined) {
	if (value === undefined) delete process.env.AGENTIC_READ_BILLING_SERVICE_ID;
	else process.env.AGENTIC_READ_BILLING_SERVICE_ID = value;
}

afterEach(() => withEnv(undefined));

describe("isAgenticReadBillingService", () => {
	it("admits the configured id", () => {
		withEnv(CRON_ID);
		expect(isAgenticReadBillingService(CRON_ID)).toBe(true);
	});

	it("refuses any other id, including a real staff id", () => {
		withEnv(CRON_ID);
		expect(isAgenticReadBillingService("some-staff-user-id")).toBe(false);
	});

	// Fails closed: unset means nobody, not everybody — same posture as isStaffUser.
	it("admits nobody when unset or empty", () => {
		withEnv(undefined);
		expect(isAgenticReadBillingService(CRON_ID)).toBe(false);
		withEnv("");
		expect(isAgenticReadBillingService(CRON_ID)).toBe(false);
		withEnv("   ");
		expect(isAgenticReadBillingService(CRON_ID)).toBe(false);
	});

	it("refuses a missing user id rather than throwing", () => {
		withEnv(CRON_ID);
		expect(isAgenticReadBillingService(null)).toBe(false);
		expect(isAgenticReadBillingService(undefined)).toBe(false);
		expect(isAgenticReadBillingService("")).toBe(false);
	});

	it("does not match on case or partial ids", () => {
		withEnv(CRON_ID);
		expect(isAgenticReadBillingService(CRON_ID.toUpperCase())).toBe(false);
		expect(isAgenticReadBillingService(CRON_ID.slice(0, 8))).toBe(false);
		expect(isAgenticReadBillingService(`${CRON_ID}x`)).toBe(false);
	});
});
