/**
 * JSON-LD for the vendor's own page.
 *
 * Agents evaluating a vendor mostly crawl the VENDOR's domain, not ours, so the
 * script injects this into their page and it is emitted on our proof page too.
 *
 * A caveat worth keeping in mind while reading it: schema.org has no vocabulary
 * for a signed attestation. This markup is a DISCOVERY aid — it tells a crawler
 * that machine-readable proof exists and where to fetch it. The canonical,
 * verifiable surface is our own JSON, and nothing here is signed. Don't grow
 * this into a second, weaker copy of the attestation.
 */

import type { VendorProof } from "./proofs";

export function vendorJsonLd(proof: VendorProof, origin: string): Record<string, unknown> {
	const proofUrl = `${origin}/proofs/${proof.vendor.slug}`;

	return {
		"@context": "https://schema.org",
		"@type": "Organization",
		name: proof.vendor.name,
		url: `https://${proof.vendor.domain}`,
		subjectOf: {
			"@type": "Dataset",
			name: `Letterprove attestations for ${proof.vendor.name}`,
			description:
				`Cryptographically signed attestations of ${proof.summary.attested_customers} verified ` +
				`customers of ${proof.vendor.name}, covering ${proof.summary.features_proven.length} ` +
				`independently attested features. Each attestation links to the open-source logic that computed it.`,
			url: proofUrl,
			dateModified: proof.summary.last_attested,
			isAccessibleForFree: true,
			creator: { "@type": "Organization", name: "Letterprove", url: "https://www.letterprove.com" },
			distribution: [
				{
					"@type": "DataDownload",
					encodingFormat: "application/json",
					contentUrl: `${proofUrl}.json`,
				},
			],
		},
	};
}
