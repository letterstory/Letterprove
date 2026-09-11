import { describe, expect, it } from "vitest";
import { vendorJsonLd } from "./jsonld";
import type { VendorProof } from "./proofs";

/**
 * The discovery markup.
 *
 * Nothing here is signed, and that is the point worth guarding: this tells a
 * crawler that machine-readable proof EXISTS and where to fetch it. The tests
 * below are mostly about keeping it that shape — a second, weaker copy of the
 * attestation growing inside a Dataset node is the failure mode, because a
 * crawler would then have two versions of the same claim and only one of them
 * verifiable.
 */

const PROOF: VendorProof = {
	vendor: { slug: "vantage", name: "Vantage", domain: "vantage.example", category: "customer data platforms" },
	customers: [],
	summary: {
		attested_customers: 12,
		attested_unnamed: 4,
		unverified_customers: 7,
		features_proven: ["analytics", "api", "sso"],
		sessions_30d: 38_000,
		last_attested: "2026-08-01T00:00:00.000Z",
		tier: 2,
		companies_observed: 31,
	},
};

const ORIGIN = "https://www.letterprove.com";

describe("vendorJsonLd", () => {
	it("emits an Organization in the schema.org context", () => {
		const ld = vendorJsonLd(PROOF, ORIGIN);

		expect(ld["@context"]).toBe("https://schema.org");
		expect(ld["@type"]).toBe("Organization");
		expect(ld.name).toBe("Vantage");
	});

	it("points url at the VENDOR's domain, not ours", () => {
		// The markup is injected into the vendor's own page. An Organization
		// node whose url pointed at letterprove.com would be describing us.
		const ld = vendorJsonLd(PROOF, ORIGIN);

		expect(ld.url).toBe("https://vantage.example");
	});

	it("links the proof page and the machine-readable download off the given origin", () => {
		const ld = vendorJsonLd(PROOF, ORIGIN);
		const dataset = ld.subjectOf as Record<string, unknown>;

		expect(dataset["@type"]).toBe("Dataset");
		expect(dataset.url).toBe("https://www.letterprove.com/proofs/vantage");
		const [download] = dataset.distribution as Record<string, unknown>[];
		expect(download["@type"]).toBe("DataDownload");
		expect(download.encodingFormat).toBe("application/json");
		expect(download.contentUrl).toBe("https://www.letterprove.com/proofs/vantage.json");
	});

	it("builds every URL from the origin it was handed, so a preview deploy links to itself", () => {
		const ld = vendorJsonLd(PROOF, "https://letterprove-git-branch.vercel.app");
		const dataset = ld.subjectOf as Record<string, unknown>;

		expect(dataset.url).toBe("https://letterprove-git-branch.vercel.app/proofs/vantage");
		expect(JSON.stringify(ld)).not.toContain("www.letterprove.com/proofs");
	});

	it("carries the counts from the summary into the description", () => {
		const ld = vendorJsonLd(PROOF, ORIGIN);
		const dataset = ld.subjectOf as Record<string, unknown>;

		expect(dataset.description).toContain("12 verified");
		expect(dataset.description).toContain("3 ");
		expect(dataset.name).toBe("Letterprove attestations for Vantage");
	});

	it("dates the dataset by the vendor's last attestation, not by render time", () => {
		// dateModified is what a crawler uses to decide whether to refetch. If it
		// tracked the render it would change on every crawl and mean nothing.
		const ld = vendorJsonLd(PROOF, ORIGIN);

		expect((ld.subjectOf as Record<string, unknown>).dateModified).toBe("2026-08-01T00:00:00.000Z");
	});

	it("names nobody, even when the vendor has named customers", () => {
		// Consent gates naming on EVERY surface. This one is injected into a
		// third-party page and crawled by everything, so it is the worst place
		// for a name to escape.
		const ld = vendorJsonLd(
			{
				...PROOF,
				customers: [{ current: { customer_name: "Acme Corp" }, chain: [] }] as never,
			},
			ORIGIN
		);

		expect(JSON.stringify(ld)).not.toContain("Acme Corp");
	});

	it("stays a discovery pointer rather than a second copy of the attestation", () => {
		// A signature, a tier, or a hash appearing here would be an unsigned
		// restatement of a signed claim — two versions of one fact, one of them
		// unverifiable.
		const keys = new Set<string>();
		const walk = (node: unknown) => {
			if (Array.isArray(node)) return node.forEach(walk);
			if (node && typeof node === "object") {
				for (const [k, v] of Object.entries(node)) {
					keys.add(k);
					walk(v);
				}
			}
		};
		walk(vendorJsonLd(PROOF, ORIGIN));

		for (const field of ["signature", "key_id", "prev_hash", "observed_through", "tier", "sessions_30d"]) {
			expect([...keys]).not.toContain(field);
		}
	});

	it("declares itself free to access, which is what makes the pointer useful", () => {
		const dataset = vendorJsonLd(PROOF, ORIGIN).subjectOf as Record<string, unknown>;

		expect(dataset.isAccessibleForFree).toBe(true);
		expect(dataset.creator).toEqual({
			"@type": "Organization",
			name: "Letterprove",
			url: "https://www.letterprove.com",
		});
	});

	it("survives a vendor with nothing attested yet without emitting broken markup", () => {
		const empty: VendorProof = {
			...PROOF,
			summary: { ...PROOF.summary, attested_customers: 0, features_proven: [], last_attested: "" },
		};

		const dataset = vendorJsonLd(empty, ORIGIN).subjectOf as Record<string, unknown>;

		expect(dataset.description).toContain("0 verified");
		expect(dataset.dateModified).toBe("");
	});

	it("serialises to JSON without throwing, since it is emitted inside a script tag", () => {
		expect(() => JSON.stringify(vendorJsonLd(PROOF, ORIGIN))).not.toThrow();
	});
});
