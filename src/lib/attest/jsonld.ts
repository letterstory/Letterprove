/**
 * JSON-LD for the vendor's own page.
 *
 * Agents evaluating a vendor mostly crawl the VENDOR's domain, not ours. The
 * only thing that emits this today is our own /proofs/{vendor} page, so it
 * reaches the vendor's domain only when they proxy `vendor.com/proofs/*` to us.
 * attest.js does NOT inject it: the collector never writes to the host page.
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
			name: `Letterprove attestation for ${proof.vendor.name}`,
			description:
				`A signed, hourly attestation that ${proof.vendor.name} controls ${proof.vendor.domain} (proven by DNS) and is backed by ` +
				`observed usage: ${proof.summary.companies_observed} companies observed signing in over the last 30 days, ` +
				`${proof.summary.paying_companies} of them paying through ${proof.vendor.name}'s own Stripe account. ` +
				`Counts only; no customer is named. It links to the open-source logic that computed it.`,
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
