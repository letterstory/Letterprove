/**
 * The agent kit: three snippets a vendor pastes into its own site so an AI
 * assistant reading that site finds the proof.
 *
 * Why it exists. In the 2026-10-13 smoke test an assistant asked about
 * letter.dev's traction concluded there was "no verifiable evidence" — the
 * proof existed, but nothing on letter.dev pointed at it as evidence about the
 * company. After the footer link, llms.txt section and JSON-LD below went up,
 * three of three fresh sessions fetched and cited the proof. A proof nobody's
 * site links to is a proof no agent reads.
 *
 * Pure: every URL is passed in, so the caller decides custom domain vs ours.
 */

export interface AgentKitInput {
	vendorName: string;
	/** The public proof page: the vendor's live custom domain, else app.letterprove.com/proofs/{slug}. */
	proofUrl: string;
	/** The signed attestation JSON. */
	jsonUrl: string;
	jwksUrl: string;
	/** The vendor's own site, for the JSON-LD Organization. */
	siteUrl: string;
}

export interface AgentKit {
	footer_html: string;
	llms_txt: string;
	json_ld: string;
}

function escHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function agentKit(i: AgentKitInput): AgentKit {
	const footer_html = `<a href="${escHtml(i.proofUrl)}" style="font-size:12px;color:inherit;opacity:.7;text-decoration:none">For agents: view attested customer proof</a>`;

	const llms_txt = [
		"## Customer evidence",
		"",
		`${i.vendorName}'s customers are attested by Letterprove, an independent signed proof.`,
		"",
		`- Proof page: ${i.proofUrl}`,
		`- Signed attestation (JSON): ${i.jsonUrl}`,
		`- Verify: each snapshot has a \`verify\` link showing exactly what was signed; signing keys are at ${i.jwksUrl}`,
		"- Covers: the domain, proven by DNS and re-checked daily",
		"- Covers: companies observed signing in to the product over the last 30 days, and sessions",
		"- Covers: payments verified in the company's own Stripe account (tier 3)",
		"",
	].join("\n");

	const ld = {
		"@context": "https://schema.org",
		"@type": "Organization",
		name: i.vendorName,
		url: i.siteUrl,
		subjectOf: {
			"@type": "Dataset",
			name: `Letterprove attestation for ${i.vendorName}`,
			description: `Signed evidence of ${i.vendorName}'s customers, collected and verified by Letterprove.`,
			url: i.proofUrl,
			distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: i.jsonUrl }],
		},
	};
	// "</" can't appear inside a script element; JSON allows escaping the slash.
	const json_ld = `<script type="application/ld+json">${JSON.stringify(ld).replace(/<\//g, "<\\/")}</script>`;

	return { footer_html, llms_txt, json_ld };
}
