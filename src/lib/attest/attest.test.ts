import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { buildChain } from "./chain";
import { jwks } from "./keys";
import { signAttestation } from "./sign";
import { GENESIS_HASH, verifyAttestation, verifyChain } from "./verify";
import type { AttestationBody, SignedAttestation } from "./types";

const BODY: AttestationBody = {
	vendor: "vantage",
	customer: "acme-corp",
	customer_name: "Acme Corp",
	verified: true,
	tier: 2,
	since: "2023-03",
	features: ["analytics", "api", "sso"],
	sessions_30d: 4182,
	seats_active: 148,
	observed_through: "2026-08-09T00:00:00Z",
	published_at: "2026-08-09T02:05:00Z",
	ttl: 3600,
	prev_hash: GENESIS_HASH,
	method: "https://github.com/letterstory/Letterprove/blob/main/src/lib/attest/proofs.ts",
};

describe("canonicalize", () => {
	it("is independent of key insertion order", () => {
		expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
		expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("sorts nested keys but preserves array order", () => {
		expect(canonicalize({ z: { y: 1, x: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"z":{"x":2,"y":1}}');
	});

	it("refuses non-integer numbers rather than signing bytes a verifier may not reproduce", () => {
		expect(() => canonicalize({ roi: 6.1 })).toThrow(/non-integer/);
	});

	it("refuses non-finite numbers", () => {
		expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
	});
});

describe("signing", () => {
	it("round-trips", async () => {
		const signed = await signAttestation(BODY);
		expect(verifyAttestation(signed, jwks())).toEqual({ ok: true });
	});

	it("stamps the key id that actually signed", async () => {
		const signed = await signAttestation(BODY);
		expect(signed.key_id).toBe(jwks().keys[0].kid);
	});

	it("detects a changed number", async () => {
		const signed = await signAttestation(BODY);
		const tampered: SignedAttestation = { ...signed, sessions_30d: 99999 };
		expect(verifyAttestation(tampered, jwks()).ok).toBe(false);
	});

	it("detects a claim promoted to verified", async () => {
		const signed = await signAttestation({ ...BODY, verified: false, tier: 1 });
		const tampered: SignedAttestation = { ...signed, verified: true, tier: 2 };
		expect(verifyAttestation(tampered, jwks()).ok).toBe(false);
	});

	it("detects a swapped key id", async () => {
		const signed = await signAttestation(BODY);
		const tampered: SignedAttestation = { ...signed, key_id: "lp-someone-else" };
		expect(verifyAttestation(tampered, jwks())).toMatchObject({ ok: false });
	});

	it("reports an unpublished key rather than failing opaquely", async () => {
		const signed = await signAttestation(BODY);
		const result = verifyAttestation({ ...signed, key_id: "lp-retired" }, jwks());
		expect(result.reason).toMatch(/no published key/);
	});
});

describe("chain", () => {
	const bodies = [
		{ ...BODY, sessions_30d: 4055, observed_through: "2026-07-31T00:00:00Z" },
		{ ...BODY, sessions_30d: 4182, observed_through: "2026-08-09T00:00:00Z" },
	].map(({ prev_hash: _prev, ...rest }) => rest);

	it("starts at genesis and links each snapshot to the last", async () => {
		const chain = await buildChain(bodies);
		expect(chain[0].prev_hash).toBe(GENESIS_HASH);
		expect(chain[1].prev_hash).not.toBe(GENESIS_HASH);
		expect(verifyChain(chain, jwks())).toEqual({ ok: true });
	});

	it("is deterministic — same inputs, same bytes", async () => {
		const [a, b] = await Promise.all([buildChain(bodies), buildChain(bodies)]);
		expect(canonicalize(a)).toBe(canonicalize(b));
	});

	it("catches history rewritten in the middle", async () => {
		const chain = await buildChain(bodies);
		// Re-sign the first snapshot with a different number, properly — strip the
		// old signature so the forgery is a well-formed document. Its own
		// signature then verifies, and ONLY the chain link exposes the edit. That
		// is the whole reason the chain exists.
		const { signature: _sig, key_id: _kid, ...body } = chain[0];
		const rewritten = await signAttestation({ ...body, sessions_30d: 1 });
		expect(verifyAttestation(rewritten, jwks())).toEqual({ ok: true });

		const result = verifyChain([rewritten, chain[1]], jwks());
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/prev_hash/);
	});

	it("refuses to re-sign a document that still carries its old signature", async () => {
		const chain = await buildChain(bodies);
		await expect(signAttestation({ ...chain[0], sessions_30d: 1 })).rejects.toThrow(/already carries/);
	});

	it("catches a dropped snapshot", async () => {
		const chain = await buildChain(bodies);
		expect(verifyChain([chain[1]], jwks()).ok).toBe(false);
	});
});
