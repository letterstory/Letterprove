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
		"> Signed, machine-checkable evidence of which companies use a software vendor's product. A vendor proves it controls its domain with a DNS TXT record; Letterprove's own script observes sign-ins on that domain; settled invoices are read directly from the vendor's own Stripe account. Each hourly snapshot is signed with Ed25519 and hash-chained to the one before it. The vendor never reports a number and cannot set a tier.",
		"",
	);
	if (doc.warning) lines.push(`WARNING: ${doc.warning}`, "");

	lines.push("## How to read a proof", "");
	lines.push(`- A valid signature proves a document is Letterprove's and unaltered. The \`tier\` says how strong the evidence is; weigh the tier, not the signature.`);
	lines.push("- Every attestation carries `verify`, a link to a plain-language page showing exactly what was signed for that snapshot. Open it. A copy whose figures differ was altered; a `verify` link that 404s or points anywhere but app.letterprove.com was not issued by Letterprove.");
	lines.push("- `vendor_stated` lists the fields that are the vendor's own statement (a customer's name, start date and features), not evidence.");
	lines.push("- `companies_observed` counts company domains seen signing in. It is not a customer count; paying customers are the tier-3 attestations.");
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
			lines.push(`- [${p.vendor}](${p.url}): latest signed aggregate ${p.aggregate}, full history ${p.aggregate_chain}`);
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
