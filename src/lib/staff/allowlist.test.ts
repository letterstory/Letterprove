import { afterEach, describe, expect, it } from "vitest";
import { isStaffUser, staffAccessConfigured, staffUserIds } from "./allowlist";

const ALICE = "780a05ec-5121-4313-951f-9601e0a162fe";
const MALLORY = "00000000-0000-0000-0000-000000000000";

function withEnv(value: string | undefined) {
	if (value === undefined) delete process.env.STAFF_USER_IDS;
	else process.env.STAFF_USER_IDS = value;
}

afterEach(() => withEnv(undefined));

describe("staffUserIds", () => {
	it("parses a comma-separated list", () => {
		withEnv(`${ALICE},${MALLORY}`);
		expect(staffUserIds()).toEqual([ALICE, MALLORY]);
	});

	// Vercel's env editor and copy-paste both introduce spaces and newlines.
	it("tolerates whitespace, newlines and trailing separators", () => {
		withEnv(` ${ALICE} ,\n ${MALLORY},, `);
		expect(staffUserIds()).toEqual([ALICE, MALLORY]);
	});
});

describe("isStaffUser", () => {
	it("admits a listed id", () => {
		withEnv(ALICE);
		expect(isStaffUser(ALICE)).toBe(true);
	});

	/**
	 * The whole point. Before the allowlist existed, ANY session passed the
	 * staff wall — and with open signup and mailer_autoconfirm on, a session was
	 * one form submission away for anyone on the internet.
	 */
	it("refuses a signed-in user who is not listed", () => {
		withEnv(ALICE);
		expect(isStaffUser(MALLORY)).toBe(false);
	});

	/**
	 * Fails CLOSED. An unset list must mean nobody, not everybody — the opposite
	 * default is exactly the bug this file exists to close, and a deployment
	 * that has not named its staff should serve no staff surface at all.
	 */
	it("admits nobody when the list is unset or empty", () => {
		withEnv(undefined);
		expect(isStaffUser(ALICE)).toBe(false);
		withEnv("");
		expect(isStaffUser(ALICE)).toBe(false);
		withEnv("  ,  ");
		expect(isStaffUser(ALICE)).toBe(false);
	});

	it("refuses a missing user id rather than throwing", () => {
		withEnv(ALICE);
		expect(isStaffUser(null)).toBe(false);
		expect(isStaffUser(undefined)).toBe(false);
		expect(isStaffUser("")).toBe(false);
	});

	// Ids are UUIDs that get copied, never typed, so a near-miss is a mistake or
	// an attempt — not something to be helpful about.
	it("does not match on case or partial ids", () => {
		withEnv(ALICE);
		expect(isStaffUser(ALICE.toUpperCase())).toBe(false);
		expect(isStaffUser(ALICE.slice(0, 8))).toBe(false);
		expect(isStaffUser(`${ALICE}x`)).toBe(false);
	});
});

describe("staffAccessConfigured", () => {
	it("reports whether this deployment has any staff at all", () => {
		withEnv(undefined);
		expect(staffAccessConfigured()).toBe(false);
		withEnv(ALICE);
		expect(staffAccessConfigured()).toBe(true);
	});
});
