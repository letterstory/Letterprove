import { describe, expect, it } from "vitest";
import { proofJson, retiredCustomerProof } from "./http";

describe("cache policy", () => {
	it("caches a proof for an hour with stale-while-revalidate", () => {
		// Names nobody, read in bulk by agents — edge caching is the right trade.
		const cc = proofJson({}, 3600).headers.get("cache-control")!;
		expect(cc).toContain("max-age=3600");
		expect(cc).toContain("stale-while-revalidate");
	});

	it("never lets Vercel's edge answer a proof read, so every read reaches the access log", () => {
		// An edge HIT skips the route and with it logProofAccess — the read is
		// invisible to the log and to agentic-read billing.
		expect(proofJson({}).headers.get("vercel-cdn-cache-control")).toBe("no-store");
	});
});

describe("retiredCustomerProof", () => {
	it("answers 410, cross-origin readable, with the vendor attestation linked", async () => {
		const res = retiredCustomerProof("acme");
		expect(res.status).toBe(410);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect((await res.json()).vendor_proof).toBe("https://app.letterprove.com/attest/acme.json");
	});

	it("escapes the vendor slug in the HTML form", async () => {
		const html = await retiredCustomerProof('a"<b>', { html: true }).text();
		expect(html).not.toContain("<b>");
	});
});
