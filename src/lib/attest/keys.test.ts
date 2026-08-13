import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jwks, publicJwk } from "./keys";

const ENV_KEYS = ["LETTERPROVE_PRODUCTION_JWK", "LETTERPROVE_RETIRED_JWKS"] as const;
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
		const production = {
			kty: "OKP" as const,
			crv: "Ed25519" as const,
			x: "not-the-dev-key-x-value",
			kid: "lp-real-1",
			alg: "EdDSA" as const,
			use: "sig" as const,
		};
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
		process.env.LETTERPROVE_PRODUCTION_JWK = JSON.stringify({
			kty: "OKP",
			crv: "Ed25519",
			x: "prod-x",
			kid: "lp-real-1",
			alg: "EdDSA",
			use: "sig",
		});
		process.env.LETTERPROVE_RETIRED_JWKS = JSON.stringify([
			{ kty: "OKP", crv: "Ed25519", x: "old-x", kid: "lp-retired-1", alg: "EdDSA", use: "sig" },
		]);

		const keys = jwks().keys;
		expect(keys).toHaveLength(2);
		expect(keys[0].kid).toBe("lp-real-1");
		expect(keys[1].kid).toBe("lp-retired-1");
	});
});
