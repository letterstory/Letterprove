import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPublicKey } from "node:crypto";
import { isDemonstration, jwks, jwksResult, keyFromSeedString, keyProblem, KeysUnavailableError, publicJwk, signingMode } from "./keys";

/** A real Ed25519 public JWK, unrelated to the development key. */
function realJwk(seed: string, kid: string) {
	const { x } = createPublicKey(keyFromSeedString(seed)).export({ format: "jwk" }) as { x: string };
	return { kty: "OKP" as const, crv: "Ed25519" as const, x, kid, alg: "EdDSA" as const, use: "sig" as const };
}

function countersigned() {
	process.env.LETTERSTORY_COUNTERSIGN_URL = "https://letterstory.example/api/letterprove/countersign";
	process.env.LETTERSTORY_COUNTERSIGN_SECRET = "shh";
}

const ENV_KEYS = [
	"LETTERPROVE_PRODUCTION_JWK",
	"LETTERPROVE_RETIRED_JWKS",
	"LETTERSTORY_COUNTERSIGN_URL",
	"LETTERSTORY_COUNTERSIGN_SECRET",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("jwks — LETTERPROVE_PRODUCTION_JWK override", () => {
	it("serves the locally-derived key when no production key is configured", () => {
		expect(jwks().keys[0]).toEqual(publicJwk());
	});

	it("serves the configured production key instead of the local one when set", () => {
		const production = realJwk("production", "lp-real-1");
		process.env.LETTERPROVE_PRODUCTION_JWK = JSON.stringify(production);

		const keys = jwks().keys;
		expect(keys[0]).toEqual(production);
		expect(keys[0]).not.toEqual(publicJwk());
	});

	it("falls back to the local key rather than throwing on malformed JSON", () => {
		process.env.LETTERPROVE_PRODUCTION_JWK = "{not json";
		expect(jwks().keys[0]).toEqual(publicJwk());
	});

	it("falls back to the local key when the configured value is an array, not an object", () => {
		process.env.LETTERPROVE_PRODUCTION_JWK = "[]";
		expect(jwks().keys[0]).toEqual(publicJwk());
	});

	it("still appends retired keys after a configured production key", () => {
		process.env.LETTERPROVE_PRODUCTION_JWK = JSON.stringify(realJwk("production", "lp-real-1"));
		process.env.LETTERPROVE_RETIRED_JWKS = JSON.stringify([realJwk("retired", "lp-retired-1")]);

		const keys = jwks().keys;
		expect(keys).toHaveLength(2);
		expect(keys[0].kid).toBe("lp-real-1");
		expect(keys[1].kid).toBe("lp-retired-1");
	});
});

describe("jwks — fails closed when Letterstory signs", () => {
	it("serves only the production key, never the local one", () => {
		countersigned();
		process.env.LETTERPROVE_PRODUCTION_JWK = JSON.stringify(realJwk("production", "lp-real-1"));
		expect(jwks().keys.map((k) => k.kid)).toEqual(["lp-real-1"]);
		expect(keyProblem()).toBeNull();
	});

	it.each([
		["unset", undefined],
		["malformed JSON", "{not json"],
		["not a key", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "short", kid: "lp" })],
		["the development key", JSON.stringify(publicJwk())],
	])("refuses to serve any key when the production key is %s", (_label, raw) => {
		countersigned();
		if (raw !== undefined) process.env.LETTERPROVE_PRODUCTION_JWK = raw;
		const result = jwksResult();
		expect(result.ok).toBe(false);
		expect(keyProblem()).toBeTruthy();
		expect(() => jwks()).toThrow(KeysUnavailableError);
	});
});

describe("signingMode", () => {
	// The production bug this exists to prevent: `signingKey().isDev` stays
	// true forever once Letterstory holds the key, because this service is
	// never given LETTERPROVE_SIGNING_KEY. Anything asking "is this a
	// demonstration" via isDev therefore mislabels real countersigned proofs
	// as "not evidence" — which is precisely what an evaluating agent reads
	// and discounts.
	it("reports countersigned — not development — when the RPC is configured", () => {
		process.env.LETTERSTORY_COUNTERSIGN_URL = "https://letterstory.example/api/letterprove/countersign";
		process.env.LETTERSTORY_COUNTERSIGN_SECRET = "shh";

		expect(signingMode()).toBe("countersigned");
		expect(isDemonstration()).toBe(false);
	});

	it("needs both halves of the RPC config before it counts as countersigned", () => {
		process.env.LETTERSTORY_COUNTERSIGN_URL = "https://letterstory.example/api/letterprove/countersign";

		expect(signingMode()).toBe("development");
		expect(isDemonstration()).toBe(true);
	});

	it("reports development when nothing is configured, so the warning still shows", () => {
		expect(signingMode()).toBe("development");
		expect(isDemonstration()).toBe(true);
	});
});
