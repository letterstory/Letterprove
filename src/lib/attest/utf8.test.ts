import { describe, expect, it } from "vitest";
import { canonicalize, canonicalBytes } from "./canonical";
import { signAttestation } from "./sign";
import { jwks } from "./keys";
import { verifyAttestation } from "./verify";
import { GENESIS_HASH } from "./verify";
import type { AttestationBody, SignedAttestation } from "./types";

const BODY = (name: string): AttestationBody => ({
	vendor: "v", customer: "c", customer_name: name, customer_domain: "c.example", verified: true, tier: 2,
	since: "2024-01", features: [], sessions_30d: 1, seats_active: 0,
	observed_through: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z",
	ttl: 3600, prev_hash: GENESIS_HASH, method: "https://x/y",
});

// Customer names are company names, so non-ASCII is not an edge case here.
// The signature is over UTF-8 bytes: a consumer that decodes them as latin-1
// recomputes different bytes and rejects a perfectly valid document, which is
// why the proof endpoints state charset explicitly (src/lib/http.ts).
describe("non-ascii in signed documents", () => {
	it("round-trips a company name with accents through sign and verify", async () => {
		const signed = await signAttestation(BODY("Café Müller GmbH"));
		expect(verifyAttestation(signed as SignedAttestation, jwks())).toEqual({ ok: true });
	});

	it("canonicalises non-ascii as UTF-8 bytes, not escapes", () => {
		const bytes = canonicalBytes({ n: "Café" });
		expect(bytes.toString("utf8")).toContain("Café");
		// JSON.stringify leaves non-ascii literal; the signature is over these bytes.
		expect(canonicalize({ n: "Café" })).toBe('{"n":"Café"}');
	});

	it("a latin-1 misreading of those bytes would NOT verify", async () => {
		const signed = await signAttestation(BODY("Café"));
		const mangled = { ...signed, customer_name: Buffer.from("Café", "utf8").toString("latin1") };
		expect(verifyAttestation(mangled as SignedAttestation, jwks()).ok).toBe(false);
	});
});
