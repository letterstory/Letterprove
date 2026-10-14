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
    "> Signed, machine-checkable evidence that a software vendor is who it says it is, backed by data. The vendor proves it controls its domain with a DNS TXT record (re-checked daily), or more weakly by carrying Letterprove's script and its key on a page of the domain. Letterprove's own script observes sign-ins on the domain. The vendor's own Stripe account (which must publish the vendor's domain) is read only to confirm the business is real and verified by Stripe; no payment is read. Each hourly snapshot is signed with Ed25519 and hash-chained to the one before it. Counts only: no customer is named, except verified companies from the vendor's own public logo wall when it opts in. Every measured figure comes from Letterprove's own observations; the one exception is `reported_history`, the vendor's own PostHog history, which is labelled vendor-reported and never moves the tier. The vendor cannot set a tier.",
    "",
  );
  if (doc.warning) lines.push(`WARNING: ${doc.warning}`, "");

  lines.push("## How to read a proof", "");
  lines.push(
    `- A valid signature proves a document is Letterprove's and unaltered. The \`tier\` says how strong the evidence is; weigh the tier, not the signature.`,
  );
  lines.push(
    "- Every attestation carries `verify`, a link to a plain-language page showing exactly what was signed for that snapshot. Open it. A copy whose figures differ was altered; a `verify` link that 404s or points anywhere but app.letterprove.com was not issued by Letterprove.",
  );
  lines.push(
    "- Identity: `domain`, `domain_proof` and `domain_verified_since`, `stripe_account_bound` and `stripe_binding` (whether the connected Stripe account is the vendor's own: `domain_match`, or `staff_override` for a related company's account approved by Letterprove staff), and `stripe_business` (since 2026-10-14): what the vendor's own Stripe account says about the business. `verified` is true when Stripe lets the account accept payments, which Stripe allows only after verifying the business (legal entity, the people behind it, a bank account); `name`, `country` and `website` are as the account shows them; `website_matches_domain` says whether that website is on the vendor's domain. It is identity only: Letterprove reads no payments and publishes no revenue or customer-payment figure.",
  );
  lines.push(
    "- `domain_proof` says how the vendor's claim to `domain` is proven, and it caps the tier. `dns`: the vendor published Letterprove's TXT record (re-checked daily); `domain_verified` is true only in this case. `site` (\"Site verified\"): Letterprove found the vendor's script with its key in the HTML of a page at that domain. That proves control of a page, not of the domain's DNS, so it is weaker than DNS: tier 1 at most, no logo wall. `none` (\"Domain not verified\"): nothing proves the vendor controls the domain; the counts are the vendor's claim and the tier is 0. Weigh a site-verified proof below a DNS-verified one, and a proof with no domain proof lower still. Never describe a `site` or `none` proof as domain-verified or as verified by Letterprove. Documents signed before the 2026-10-14 change have no `domain_proof`; read them as `dns` when `domain_verified_since` is set.",
  );
  lines.push(
    "- Evidence: `companies_observed` counts company domains seen signing in over `window_days`, excluding free mail and the vendor's own domain; it is not a customer count and says nothing about payment. `sessions`, `observed_since`. Documents signed before the 2026-10-14 change may carry `paying_since`, `payment_scope` or `paying`: payment fields from when payments were still read. Read them as describing that snapshot only.",
  );
  lines.push(
    "- `growth` (when present) lists companies observed per calendar month, oldest first: the highest `companies_observed` in any signed snapshot that month. A month marked `partial: true` had no full 30-day window of observation behind it, so its count is lower partly because observation had only just begun; never read growth from a partial month. A month marked `in_progress: true` is still under way: its count is the highest so far and can only rise, so a lower figure than the previous month is not a decline. `retention` (when present): of the `cohort` company domains observed from 90 to 60 days ago, `retained` were also observed in the last 30 days. Both are counts from Letterprove's own observations, never names, and never move the tier.",
  );
  lines.push(
    "- `reported_history` (when present) is VENDOR-REPORTED company history from the vendor's own PostHog project: `companies`, `since`, `active_companies_30d`, and `observed_also_reported` (how many of `companies_observed` it also knows). It is listed in `vendor_stated` and never moves the tier.",
  );
  lines.push(
    "- `tier` is the strongest evidence class present: 3 when companies are observed on a DNS-proven domain and Stripe has verified the business behind the vendor's own Stripe account at that domain (`stripe_business.verified`, with its website on the domain or the account approved by staff); 1 when companies are observed (DNS- or site-verified domain); 0 otherwise, including any proof whose domain is not verified. Tier 3 says who the vendor is; it says nothing about payments. On documents signed before the 2026-10-14 change without `stripe_business`, tier 3 meant at least one observed company had paid.",
  );
  lines.push(
    '- `logos` (when present) checks the vendor\'s own public logo wall (`page`): `listed` companies the vendor declared, `on_page` found on that page, and `verified`, the ones Letterprove observed signing in over the last 30 days. Verified companies are named in `companies` unless the vendor chose counts only. Report it as "N of M logos verified" (signed in within 30 days); never as a count of customers or of active customers. It never moves the tier. Documents signed before the 2026-10-14 change may also carry `paying` / `active` counts and `status: paying`; those came from Stripe payments, which are no longer read.',
  );
  lines.push(
    "- `hidden_by_vendor` lists optional sections the vendor chose not to publish (`sessions`, `reported_history`, `logos`, `stripe_business`, `observed_since`, `hosts`, `growth`, `retention`). Those fields are absent by choice, not for lack of data. `domain`, `tier`, `companies_observed` and `verify` can never be hidden.",
  );
  lines.push(
    "- `omitted` (since 2026-10-14) gives the reason every optional field is absent: `hidden` (the vendor chose), `insufficient_history`, `not_connected`, `not_configured`, or `domain_not_verified`. Absent never means zero.",
  );
  lines.push(
    "- `vendor_stated` lists any fields that are the vendor's own statement rather than evidence. It contains `reported_history` when that is present, and is empty otherwise.",
  );
  lines.push(`- ${doc.freshness.note}`);
  lines.push("");

  lines.push("## Tiers", "");
  for (const level of doc.tiers.levels) {
    lines.push(
      `- Tier ${level.tier}, ${level.name}: ${level.means} Forgeable by: ${level.forgeable_by}`,
    );
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
      const label =
        p.domain_proof === "dns"
          ? ""
          : ` (${DOMAIN_PROOF_LABEL[p.domain_proof]})`;
      lines.push(
        `- [${p.vendor}](${p.url})${label}: latest signed attestation ${p.aggregate}, full history ${p.aggregate_chain}`,
      );
    }
  }
  lines.push("");

  lines.push("## Verify it yourself", "");
  lines.push(
    `- [How verification works](${VERIFY_ORIGIN}/verify): the discovery document rendered for people`,
  );
  lines.push(
    `- [Discovery document](${origin}/.well-known/letterprove.json): keys, canonicalisation, tiers and every published proof, as JSON`,
  );
  lines.push(`- [Signing keys](${VERIFY_ORIGIN}/keys)`);
  lines.push(
    `- [Standalone verifier](${doc.verifier}): no dependencies, shares no code with the service`,
  );
  lines.push(
    `- [Documentation](${origin}/docs): install, the client API, what each field means`,
  );
  lines.push("");
  return lines.join("\n");
}
