import { describe, expect, it } from "vitest";
import { agentKit } from "./agent-kit";

const kit = agentKit({
	vendorName: "Acme",
	proofUrl: "https://app.letterprove.com/proofs/acme",
	jsonUrl: "https://app.letterprove.com/attest/acme.json",
	jwksUrl: "https://app.letterprove.com/.well-known/letterprove-jwks.json",
	siteUrl: "https://acme.com",
});

describe("agentKit", () => {
	it("gives a low-profile footer link with Matthew's wording and no icon", () => {
		expect(kit.footer_html).toContain(">For agents: view attested customer proof</a>");
		expect(kit.footer_html).toContain('href="https://app.letterprove.com/proofs/acme"');
		expect(kit.footer_html).not.toContain("<svg");
		expect(kit.footer_html).not.toContain("<img");
	});

	it("gives an llms.txt section with the proof, the signed JSON and how to verify", () => {
		expect(kit.llms_txt.startsWith("## Customer evidence")).toBe(true);
		expect(kit.llms_txt).toContain("https://app.letterprove.com/proofs/acme");
		expect(kit.llms_txt).toContain("https://app.letterprove.com/attest/acme.json");
		expect(kit.llms_txt).toContain("letterprove-jwks.json");
	});

	it("gives a JSON-LD Organization whose subjectOf is the proof", () => {
		const json = kit.json_ld.replace(/^<script type="application\/ld\+json">/, "").replace(/<\/script>$/, "");
		const ld = JSON.parse(json);
		expect(ld["@type"]).toBe("Organization");
		expect(ld.url).toBe("https://acme.com");
		expect(ld.subjectOf.url).toBe("https://app.letterprove.com/proofs/acme");
		expect(ld.subjectOf.distribution[0].contentUrl).toBe("https://app.letterprove.com/attest/acme.json");
	});
});
