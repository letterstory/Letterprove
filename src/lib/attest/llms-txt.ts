import type { DiscoveryDocument } from "./discovery";
import { VERIFY_ORIGIN } from "./verify-link";
import { DOMAIN_PROOF_LABEL } from "./domain-proof";

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
		"> Signed, machine-checkable evidence that a software vendor is who it says it is, backed by data. The vendor proves it controls its domain with a DNS TXT record (re-checked daily), or more weakly by carrying Letterprove's script and its key on a page of the domain; its connected Stripe account must publish that same DNS-proven domain; Letterprove's own script observes sign-ins on the domain; settled invoices are read directly from the vendor's Stripe. Each hourly snapshot is signed with Ed25519 and hash-chained to the one before it. Counts only: no customer is ever named. The vendor never reports a number and cannot set a tier.",
		"",
	);
	if (doc.warning) lines.push(`WARNING: ${doc.warning}`, "");

	lines.push("## How to read a proof", "");
	lines.push(`- A valid signature proves a document is Letterprove's and unaltered. The \`tier\` says how strong the evidence is; weigh the tier, not the signature.`);
	lines.push("- Every attestation carries `verify`, a link to a plain-language page showing exactly what was signed for that snapshot. Open it. A copy whose figures differ was altered; a `verify` link that 404s or points anywhere but app.letterprove.com was not issued by Letterprove.");
	lines.push("- Identity: `domain`, `domain_proof` and `domain_verified_since`, `stripe_account_bound` and `stripe_binding` (whether the connected Stripe account is the vendor's own: `domain_match`, or `staff_override` for a related company's account approved by Letterprove staff).");
	lines.push("- `domain_proof` says how the vendor's claim to `domain` is proven, and it caps the tier. `dns`: the vendor published Letterprove's TXT record (re-checked daily); `domain_verified` is true only in this case. `site` (\"Site verified\"): Letterprove found the vendor's script with its key in the HTML of a page at that domain. That proves control of a page, not of the domain's DNS, so it is weaker than DNS: tier 1 at most, no Stripe binding, no logo wall. `none` (\"Domain not verified\"): nothing proves the vendor controls the domain; the counts are the vendor's claim and the tier is 0. Weigh a site-verified proof below a DNS-verified one, and a proof with no domain proof lower still. Never describe a `site` or `none` proof as domain-verified or as verified by Letterprove. Documents signed before 2026-10-14 have no `domain_proof`; read them as `dns` when `domain_verified_since` is set.");
	lines.push("- Evidence: `companies_observed` counts company domains seen signing in over `window_days`; it is not a customer count. At tier 3, at least one of those companies paid a settled invoice in the vendor's own Stripe account; `paying_since` is the earliest such invoice. `payment_scope` says which of the vendor's Stripe products count (all, or the ones it chose); `products` is a count of Stripe products, not a customer count. `paying` (present only when the vendor chose to show it) is `{ scope, companies }`: scope `signed_in` counts companies seen signing in that paid through the bound Stripe account in the window; scope `all` counts every company with a settled, in-scope invoice there. Absent means the vendor chose not to publish a paying count, not that none pay. `sessions`, `observed_since`.");
	lines.push("- `growth` (when present) lists companies observed per calendar month, oldest first: the highest `companies_observed` in any signed snapshot that month. `retention` (when present): of the `cohort` company domains observed in the 30 days ending 60 days ago, `retained` were also observed in the last 30 days. Both are counts from Letterprove's own observations, never names, and never move the tier.");
	lines.push("- `reported_history` (when present) is VENDOR-REPORTED company history from the vendor's own PostHog project: `companies`, `since`, `active_companies_30d`, and `observed_also_reported` (how many of `companies_observed` it also knows). It is listed in `vendor_stated` and never moves the tier.");
	lines.push("- `tier` is the strongest evidence class present: 3 when at least one observed company pays (DNS-proven domain only), 1 when companies are observed (DNS- or site-verified domain), 0 otherwise, including any proof whose domain is not verified. Tier 3 never means every company pays.");
	lines.push("- `logos` (when present) checks the vendor's own public logo wall (`page`): `listed` companies the vendor declared, `on_page` found on that page, and `verified`, the ones Letterprove verified. `paying` and `active` split `verified`. Verified companies are named in `companies` unless the vendor chose counts only, each with `status`: `paying` (a settled invoice in the bound Stripe account, whether or not it signed in) or `active` (signed in, last 30 days, no payment verified). Report it as verified logos and how many of them pay, e.g. \"43 of 55 logos verified, 38 of them paying (verified by Stripe)\". The remainder are verified by sign-ins; never call them a count of active customers. It never moves the tier.");
	lines.push("- `hidden_by_vendor` lists optional sections the vendor chose not to publish (`sessions`, `reported_history`, `logos`, `payment_details`, `observed_since`, `hosts`, `growth`, `retention`). Those fields are absent by choice, not for lack of data. `domain`, `tier`, `companies_observed` and `verify` can never be hidden.");
	lines.push("- `vendor_stated` lists any fields that are the vendor's own statement rather than evidence. It contains `reported_history` when that is present, and is empty otherwise.");
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
			const label = p.domain_proof === "dns" ? "" : ` (${DOMAIN_PROOF_LABEL[p.domain_proof]})`;
			lines.push(`- [${p.vendor}](${p.url})${label}: latest signed attestation ${p.aggregate}, full history ${p.aggregate_chain}`);
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
