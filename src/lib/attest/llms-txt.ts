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
		"> Signed, machine-checkable evidence that a software vendor is who it says it is, backed by data. The vendor proves it controls its domain with a DNS TXT record (re-checked daily); its connected Stripe account must publish that same domain; Letterprove's own script observes sign-ins on the domain; settled invoices are read directly from the vendor's Stripe. Each hourly snapshot is signed with Ed25519 and hash-chained to the one before it. Counts only: no customer is ever named. The vendor never reports a number and cannot set a tier.",
		"",
	);
	if (doc.warning) lines.push(`WARNING: ${doc.warning}`, "");

	lines.push("## How to read a proof", "");
	lines.push(`- A valid signature proves a document is Letterprove's and unaltered. The \`tier\` says how strong the evidence is; weigh the tier, not the signature.`);
	lines.push("- Every attestation carries `verify`, a link to a plain-language page showing exactly what was signed for that snapshot. Open it. A copy whose figures differ was altered; a `verify` link that 404s or points anywhere but app.letterprove.com was not issued by Letterprove.");
	lines.push("- Identity: `domain` and `domain_verified_since` (DNS), `stripe_account_bound` and `stripe_binding` (whether the connected Stripe account is the vendor's own: `domain_match`, or `staff_override` for a related company's account approved by Letterprove staff).");
	lines.push("- Evidence: `companies_observed` counts company domains seen signing in over `window_days`; it is not a customer count. `paying_companies` is how many of those paid a settled invoice in the vendor's own Stripe account (`payment_scope` says whether all its products count or only those it chose). `sessions`, `observed_since`, `paying_since`.");
	lines.push("- `reported_history` (when present) is VENDOR-REPORTED company history from the vendor's own PostHog project: `companies`, `since`, `active_companies_30d`, and `observed_also_reported` (how many of `companies_observed` it also knows). It is listed in `vendor_stated` and never moves the tier.");
	lines.push("- `tier` is the strongest evidence class present: 3 when at least one observed company pays, 1 when companies are observed, 0 otherwise. Read it with `paying_companies`, never as \"every company pays\".");
	lines.push("- `vendor_stated` lists any fields that are the vendor's own statement rather than evidence. It is empty on vendor attestations.");
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
