import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDemonstration, jwks, publicJwk, signingMode } from "./keys";

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
