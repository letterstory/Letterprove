import { describe, expect, it } from "vitest";
import { parseObservePayload } from "./events";

const VALID = { k: "lp_live_vantage_9f2c", domain: "acme.com", ev: "session", cfg: 1, ts: 1754870400 };

describe("parseObservePayload", () => {
	it("accepts a well-formed event for each phase-1 type", () => {
		for (const ev of ["session", "signup", "login"]) {
			expect(parseObservePayload({ ...VALID, ev })).toEqual({ ...VALID, ev });
		}
	});

	it("rejects an event type outside the confirmed phase-1 list", () => {
		// The whole point of the closed enum: a typo or a speculative
		// `feature` event must not silently get through.
		expect(parseObservePayload({ ...VALID, ev: "feature" })).toBeNull();
		expect(parseObservePayload({ ...VALID, ev: "active_account" })).toBeNull();
	});

	it("rejects a missing or wrong-typed required field", () => {
		expect(parseObservePayload({ ...VALID, k: "" })).toBeNull();
		expect(parseObservePayload({ ...VALID, k: undefined })).toBeNull();
		expect(parseObservePayload({ ...VALID, domain: 123 })).toBeNull();
		expect(parseObservePayload({ ...VALID, cfg: "1" })).toBeNull();
		expect(parseObservePayload({ ...VALID, ts: "1754870400" })).toBeNull();
	});

	it("rejects non-finite numbers a JSON.parse of hostile input could produce", () => {
		expect(parseObservePayload({ ...VALID, cfg: NaN })).toBeNull();
		expect(parseObservePayload({ ...VALID, ts: Infinity })).toBeNull();
	});

	it("rejects a non-object body outright", () => {
		expect(parseObservePayload(null)).toBeNull();
		expect(parseObservePayload("session")).toBeNull();
		expect(parseObservePayload([])).toBeNull();
	});
});
