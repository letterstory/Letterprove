import { describe, expect, it } from "vitest";
import { DOMAIN_PROOF_LABEL, docDomainProof, domainProofLine, domainProofOf, tierForProof } from "./domain-proof";
import { leadSentence } from "./lead";

describe("domainProofOf", () => {
	it("prefers DNS over site, and site over nothing", () => {
		expect(domainProofOf({ domainVerified: true, siteVerifiedAt: "2026-10-14T00:00:00Z" })).toBe("dns");
		expect(domainProofOf({ domainVerified: false, siteVerifiedAt: "2026-10-14T00:00:00Z" })).toBe("site");
		expect(domainProofOf({ domainVerified: false, siteVerifiedAt: null })).toBe("none");
		expect(domainProofOf({})).toBe("none");
	});
});

describe("tierForProof", () => {
	it("caps an unproven domain at tier 0 whatever was observed or confirmed", () => {
		expect(tierForProof(true, "none", true)).toBe(0);
	});
	it("caps site proof at tier 1, never above what DNS gives", () => {
		expect(tierForProof(true, "site", false)).toBe(1);
		expect(tierForProof(true, "site", true)).toBe(1);
	});
	it("gives tier 3 on DNS only with a Stripe-confirmed business", () => {
		expect(tierForProof(true, "dns", false)).toBe(1);
		expect(tierForProof(true, "dns", true)).toBe(3);
	});
	it("is 0 with nothing observed", () => {
		expect(tierForProof(false, "dns", true)).toBe(0);
		expect(tierForProof(false, "site")).toBe(0);
	});
});

describe("labels", () => {
	it("has one label per state", () => {
		expect(DOMAIN_PROOF_LABEL).toEqual({ none: "Domain not verified", site: "Site verified", dns: "Verified by DNS" });
	});
	it("explains none and site in one plain line naming the domain, and says site is weaker than DNS", () => {
		expect(domainProofLine("none", "acme.com")).toContain("has not proven that it controls acme.com");
		expect(domainProofLine("site", "acme.com")).toContain("weaker than DNS");
		expect(domainProofLine("dns", "acme.com")).toBeNull();
	});
	it("never says 'verified by Letterprove' in the lead without DNS", () => {
		for (const proof of ["none", "site"] as const) {
			const s = leadSentence(false, proof, "acme.com");
			expect(s).not.toContain("verified by Letterprove");
			expect(s).toContain(DOMAIN_PROOF_LABEL[proof]);
		}
		expect(leadSentence(false, "dns")).toContain("collected and verified by Letterprove");
	});
});

describe("docDomainProof", () => {
	it("reads the signed field first", () => {
		expect(docDomainProof({ domain: "a.com", domain_proof: "site", domain_verified_since: null })).toBe("site");
	});
	it("falls back to domain_verified_since, then to DNS for documents older than both", () => {
		expect(docDomainProof({ domain: "a.com", domain_verified_since: "2026-09-01T00:00:00Z" })).toBe("dns");
		expect(docDomainProof({ domain: "a.com", domain_verified_since: null })).toBe("none");
		expect(docDomainProof({})).toBe("dns");
		expect(docDomainProof(null)).toBe("none");
	});
});
