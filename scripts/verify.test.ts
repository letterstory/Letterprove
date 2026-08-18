/**
 * Tests for the independent verifier.
 *
 * It is run as a SUBPROCESS against fixture files on disk, never imported. The
 * point of scripts/verify.mjs is that it shares no code with the service, so a
 * test that imported its internals would quietly become the thing it exists to
 * rule out. This exercises exactly what a sceptical third party runs: a command,
 * a document, a key set, and whatever it prints.
 *
 * Fixtures are signed here with a throwaway key rather than the service's, for
 * the same reason.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

/** RFC 8785 subset, mirroring the verifier's own rules. */
function canonicalize(v: unknown): string {
	if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
	if (typeof v === "number") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
	if (typeof v === "object")
		return `{${Object.keys(v as object)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonicalize((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	throw new Error("uncanonicalizable");
}

type Body = Record<string, unknown>;

function signed(body: Body, kid = "test-key"): Body {
	const doc = { ...body, key_id: kid };
	return { ...doc, signature: edSign(null, Buffer.from(canonicalize(doc), "utf8"), privateKey).toString("base64url") };
}

function hashOf(doc: Body): string {
	return createHash("sha256").update(canonicalize(doc), "utf8").digest("hex");
}

const GENESIS = "0".repeat(64);

function jwksFor(kids: string[]) {
	const jwk = publicKey.export({ format: "jwk" });
	return { keys: kids.map((kid) => ({ ...jwk, kid })) };
}

/** Runs the verifier, returning its output and exit code rather than throwing. */
function verify(doc: unknown, jwks: unknown): { out: string; code: number } {
	const dir = mkdtempSync(join(tmpdir(), "lp-verify-"));
	const docPath = join(dir, "doc.json");
	const jwksPath = join(dir, "jwks.json");
	writeFileSync(docPath, JSON.stringify(doc));
	writeFileSync(jwksPath, JSON.stringify(jwks));

	try {
		return { out: execFileSync("node", ["scripts/verify.mjs", docPath, "--jwks", jwksPath], { encoding: "utf8" }), code: 0 };
	} catch (e) {
		const err = e as { stdout?: string; status?: number };
		return { out: err.stdout ?? "", code: err.status ?? 1 };
	}
}

const CUSTOMER: Body = { customer: "acme-corp", tier: 0, observed_through: "2026-08-18T00:00:00Z", prev_hash: GENESIS };
const AGGREGATE: Body = { kind: "aggregate", vendor: "lettertrace", tier: 2, companies_observed: 24, observed_through: "2026-08-18T00:00:00Z", prev_hash: GENESIS };

describe("what the verifier reports", () => {
	// The tier IS the claim. A signature proves only that the body was not
	// altered — printing "verified" while staying silent about provenance lets a
	// vendor's own assertion read exactly like counter-signed evidence.
	it("states the provenance tier, not just that the signature checks out", () => {
		const { out, code } = verify(signed(CUSTOMER), jwksFor(["test-key"]));
		expect(code).toBe(0);
		expect(out).toMatch(/tier 0 — vendor-asserted/);
	});

	it("distinguishes a stronger tier from a weaker one", () => {
		expect(verify(signed(AGGREGATE), jwksFor(["test-key"])).out).toMatch(/tier 2 — infrastructure-bound/);
	});

	// A body with no tier must not be reported as tier 0 — "the vendor said so"
	// and "nothing was said" are different claims, and only one is a claim.
	it("says so when no tier is stated rather than assuming the weakest", () => {
		const { tier: _t, ...noTier } = CUSTOMER;
		expect(verify(signed(noTier), jwksFor(["test-key"])).out).toMatch(/no tier stated/);
	});

	// The aggregate has no `customer` field on purpose, so the old label printed
	// "?" for the only claim most vendors ever publish.
	it("names the aggregate's subject", () => {
		expect(verify(signed(AGGREGATE), jwksFor(["test-key"])).out).toMatch(/lettertrace \(aggregate\)/);
	});
});

describe("what the verifier refuses", () => {
	it("rejects a body altered after signing", () => {
		const doc = { ...signed(CUSTOMER), companies_observed: 9999 };
		const { out, code } = verify(doc, jwksFor(["test-key"]));
		expect(code).toBe(1);
		expect(out).toMatch(/signature does not match/);
	});

	it("rejects a signature it has no published key for", () => {
		const { out, code } = verify(signed(CUSTOMER, "some-other-key"), jwksFor(["test-key"]));
		expect(code).toBe(1);
		expect(out).toMatch(/no published key/);
	});

	// The chain's whole purpose: an entry cannot be restated without breaking
	// every link after it.
	it("rejects a chain whose links do not follow", () => {
		const first = signed(CUSTOMER);
		const second = signed({ ...CUSTOMER, observed_through: "2026-08-18T01:00:00Z", prev_hash: hashOf({ ...CUSTOMER, tier: 4 }) });
		const { out, code } = verify({ chain: [first, second] }, jwksFor(["test-key"]));
		expect(code).toBe(1);
		expect(out).toMatch(/prev_hash/);
	});

	it("accepts a chain whose links do follow", () => {
		const first = signed(CUSTOMER);
		const second = signed({ ...CUSTOMER, observed_through: "2026-08-18T01:00:00Z", prev_hash: hashOf(first) });
		const { out, code } = verify({ chain: [first, second] }, jwksFor(["test-key"]));
		expect(code).toBe(0);
		expect(out).toMatch(/2 attestations verified/);
	});
});

describe("the demonstration warning", () => {
	it("warns when the signing key is a development key", () => {
		expect(verify(signed(CUSTOMER, "dev-insecure-1"), jwksFor(["dev-insecure-1"])).out).toMatch(/not evidence/);
	});

	// The inverse of the mislabeling that shipped on 2026-08-13. A JWKS carrying
	// both keys is what a rotation looks like; stamping "demonstration" on
	// genuine countersigned proof because a dev key is merely published
	// alongside it is a false accusation against our own evidence.
	it("stays silent when a dev key is merely published beside the real one", () => {
		const { out, code } = verify(signed(CUSTOMER, "test-key"), jwksFor(["test-key", "dev-insecure-1"]));
		expect(code).toBe(0);
		expect(out).not.toMatch(/not evidence/);
	});
});
