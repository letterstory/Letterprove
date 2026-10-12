import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { jwks } from "./keys";
import { readingOrder } from "./reading-order";
import { signAttestation } from "./sign";
import { verifyAttestation } from "./verify";
import type { SignedAttestation } from "./types";

// Keys in the order Postgres jsonb hands them back (shortest first), as
// lettertrace's aggregate was served on 2026-10-12.
const STORED = {
	kind: "aggregate",
	tier: 2,
	key_id: "lp-d157ef400e",
	logins: 15,
	method: "https://github.com/letterstory/Letterprove/blob/main/src/lib/attest/aggregate.ts",
	vendor: "lettertrace",
	verify: "https://app.letterprove.com/verify/lettertrace/20261012T160507661Z",
	signups: 62,
	sessions: 143,
	prev_hash: "a".repeat(64),
	signature: "sig",
	window_days: 30,
	published_at: "2026-10-12T16:05:07.661Z",
	companies_observed: 44,
	issuer_affiliation: "Letterprove and Lettertrace are both operated by Letter Company.",
};

describe("readingOrder", () => {
	it("serves the verify link first and the issuer second, the signature last", () => {
		const keys = Object.keys(readingOrder(STORED));
		expect(keys.slice(0, 4)).toEqual(["verify", "issuer_affiliation", "vendor", "kind"]);
		expect(keys.slice(-3)).toEqual(["prev_hash", "key_id", "signature"]);
		expect(keys).toHaveLength(Object.keys(STORED).length);
	});

	it("keeps the stored order for everything it does not pin", () => {
		const keys = Object.keys(readingOrder(STORED));
		const middle = keys.filter((k) => ["logins", "method", "signups", "sessions", "window_days"].includes(k));
		expect(middle).toEqual(["logins", "method", "signups", "sessions", "window_days"]);
	});

	it("changes no value, so the canonical bytes are identical", () => {
		expect(canonicalize(readingOrder(STORED))).toBe(canonicalize(STORED));
	});

	it("leaves a real signature verifying", async () => {
		const { signature: _s, key_id: _k, ...body } = STORED;
		const signed = await signAttestation(body);
		// An aggregate, not a customer attestation — verified the same way.
		expect(verifyAttestation(readingOrder(signed) as unknown as SignedAttestation, jwks())).toEqual({ ok: true });
	});

	it("leaves an old snapshot without verify or issuer fields alone, apart from order", () => {
		const old = { tier: 1, vendor: "vantage", ttl: 3600, signature: "x" };
		expect(readingOrder(old)).toEqual(old);
		expect(Object.keys(readingOrder(old))).toEqual(["vendor", "tier", "ttl", "signature"]);
	});
});
