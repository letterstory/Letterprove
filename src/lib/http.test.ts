import { describe, expect, it } from "vitest";
import { proofJson, namedProofJson } from "./http";

describe("cache policy", () => {
	it("caches an aggregate proof for an hour with stale-while-revalidate", () => {
		// Names nobody, read in bulk by agents — edge caching is the right trade.
		const cc = proofJson({}, 3600).headers.get("cache-control")!;
		expect(cc).toContain("max-age=3600");
		expect(cc).toContain("stale-while-revalidate");
	});

	it("caches a NAMED proof briefly and never serves it stale", () => {
		// Consent is withdrawable and withdrawal must take effect now.
		// stale-while-revalidate is the specific hazard: it authorises serving a
		// document the origin has already stopped publishing.
		const cc = namedProofJson({}).headers.get("cache-control")!;
		expect(cc).toContain("max-age=60");
		expect(cc).not.toContain("stale-while-revalidate");
		expect(cc).toContain("must-revalidate");
	});

	it("keeps named proofs cross-origin readable", () => {
		// A proof nobody can fetch cross-origin is not proof.
		expect(namedProofJson({}).headers.get("access-control-allow-origin")).toBe("*");
	});
});
