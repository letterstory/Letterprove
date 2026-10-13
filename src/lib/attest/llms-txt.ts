import type { DiscoveryDocument } from "./discovery";
import { VERIFY_ORIGIN } from "./verify-link";

/**
 * /llms.txt, written from the discovery document so it can only describe what
 * we actually publish.
 *
 * Why it exists: the llms.txt an agent found for Letterprove until 2026-10-13
 * was the marketing site's, which listed five demonstration vendors with
 * invented figures and described a different signing scheme from the one this
 * service runs. This host had none at all (404). An agent reads this file
 * first, so it carries only real published vendors, the real scheme, and the
 * tier ladder with who could forge each tier.
 *
 * Keys and the verify pages are named on VERIFY_ORIGIN, never on the host that
 * served this file: a proof is checked against Letterprove's keys, not against
 * keys served from wherever the proof happens to be hosted.
 */
export function llmsTxt(doc: DiscoveryDocument, origin: string): string {
	const lines: string[] = [];
	lines.push("# Letterprove", "");
	lines.push(
		"> Signed evidence of a software vendor's customers, collected and verified by Letterprove. The vendor verifies its domain with a DNS TXT record, checked daily. Its Stripe account must publish the same domain. Letterprove's script observes sign-ins on that domain, and Letterprove reads settled invoices from Stripe directly. Each hourly snapshot is signed with Ed25519 and chained to the previous one. Figures are counts. The vendor does not report any figure and cannot set the tier.",
		"",
	);
	if (doc.warning) lines.push(`WARNING: ${doc.warning}`, "");

	lines.push("## How to read a proof", "");
	lines.push(`- A valid signature proves the document came from Letterprove and was not changed. The \`tier\` states how strong the evidence is.`);
	lines.push("- Every attestation carries `verify`, a link to a page showing the signed figures for that snapshot. A copy with different figures was altered. A `verify` link to any host other than app.letterprove.com was not issued by Letterprove.");
	lines.push("- Identity: `domain` and `domain_verified_since` (DNS). `stripe_account_bound` and `stripe_binding`: `domain_match` when the Stripe account publishes the vendor's domain, `staff_override` when Letterprove staff approved a related company's account.");
	lines.push("- Evidence: `companies_observed` is the number of company email domains that signed in during `window_days`. At tier 3, at least one of those companies paid a settled invoice in the vendor's Stripe account. `paying_since` is the first such invoice. `payment_scope` states whether all of the vendor's Stripe products count or only those it chose. The number of paying companies is not published. Also: `sessions`, `observed_since`.");
	lines.push("- `reported_history`, when present, is company history the vendor reports from its own PostHog project: `companies`, `since`, `active_companies_30d`, and `observed_also_reported` (how many of `companies_observed` also appear in PostHog). It is listed in `vendor_stated` and does not affect the tier.");
	lines.push("- `tier`: 3 when at least one observed company pays, 1 when companies are observed, 0 otherwise. Tier 3 does not mean every company pays.");
	lines.push("- `logos`, when present, checks the vendor's public logo wall at `page`. `listed` is the companies the vendor declared, `on_page` the ones found on that page, and `verified` the ones Letterprove verified. Only verified companies are named. `status` is `paying` (a settled invoice in the bound Stripe account) or `active` (signed in during the last 30 days). It does not affect the tier.");
	lines.push("- `vendor_stated` lists fields that are the vendor's own statement. It contains `reported_history` when present, and is empty otherwise.");
	lines.push(`- ${doc.freshness.note}`);
	lines.push("");

	lines.push("## Tiers", "");
	for (const level of doc.tiers.levels) {
		lines.push(`- Tier ${level.tier}, ${level.name}: ${level.means} Forgeable by: ${level.forgeable_by}`);
	}
	lines.push("");

	lines.push("## Who issues these", "");
	lines.push(`- Operated by ${doc.issuer.operator}.`);
	lines.push(`- A vendor decides ${doc.issuer.vendor_controls.join("; ")}.`);
	lines.push(`- A vendor cannot ${doc.issuer.vendor_cannot.join("; ")}.`);
	if (doc.issuer.affiliated_vendors.length) {
		lines.push(
			`- Shares an owner with Letterprove's operator, disclosed in every attestation: ${doc.issuer.affiliated_vendors.map((v) => v.vendor).join(", ")}.`,
		);
	}
	lines.push("");

	lines.push("## Published proofs", "");
	if (doc.proofs.length === 0) {
		lines.push("- None published yet.");
	} else {
		for (const p of doc.proofs) {
			lines.push(`- [${p.vendor}](${p.url}): latest signed attestation ${p.aggregate}, full history ${p.aggregate_chain}`);
		}
	}
	lines.push("");

	lines.push("## Verify it yourself", "");
	lines.push(`- [How verification works](${VERIFY_ORIGIN}/verify): the discovery document rendered for people`);
	lines.push(`- [Discovery document](${origin}/.well-known/letterprove.json): keys, canonicalisation, tiers and every published proof, as JSON`);
	lines.push(`- [Signing keys](${VERIFY_ORIGIN}/keys)`);
	lines.push(`- [Standalone verifier](${doc.verifier}): no dependencies, shares no code with the service`);
	lines.push(`- [Documentation](${origin}/docs): install, the client API, what each field means`);
	lines.push("");
	return lines.join("\n");
}
