import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { Mono } from "@/components/ui";
import { SNAPSHOT_CADENCE_SECONDS } from "@/lib/attest/cadence";
import { tierLadderDocument } from "@/lib/attest/tiers";
import { VERIFY_ORIGIN } from "@/lib/attest/verify-link";
import {
  ATTEST_SCRIPT_PATH,
  installSnippet,
  originFromHeaders,
} from "@/lib/vendors/install";
import { TXT_PREFIX, verificationHosts } from "@/lib/vendors/verification";

/**
 * The vendor-facing documentation. `/docs` 404'd until this existed, and
 * nothing anywhere told a vendor how to install the script, what a tier meant,
 * or that an independent verifier exists at all.
 *
 * Two rules this page lives by, both learned the expensive way elsewhere in
 * the repo:
 *
 *   1. Every host, path and snippet is derived from the request, never written
 *      down. `src/lib/vendors/install.ts` records two incidents where a
 *      hardcoded host silently broke collection, and a docs page that prints a
 *      stale origin causes the same failure with more authority.
 *   2. Anything with a definition in code is rendered FROM that code. The tier
 *      ladder comes from `tierLadderDocument()`, the same builder the discovery
 *      document and /verify use, so documentation cannot describe a scheme we
 *      do not publish. The cooldown, the script path and the DNS hosts come
 *      from their own modules for the same reason.
 *
 * What is deliberately NOT dressed up: companies observed are not
 * customers, tier 3 says who the vendor is and nothing about payments, tier 2 is not issued, and the tier-3 section says out loud what a determined vendor
 * can still do. A page that reads better than the system behaves is the one
 * failure this product cannot afford.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Docs — Letterprove",
  description:
    "How to install Letterprove, what a vendor attestation says, what the tiers mean, and how to verify any published attestation yourself.",
};

const SECTIONS = [
  { id: "install", title: "Install" },
  { id: "client-api", title: "The client API" },
  { id: "published", title: "What a published attestation says" },
  { id: "tiers", title: "The tier ladder" },
  { id: "customers", title: "Your customers stay private" },
  { id: "showing", title: "Badge and your own domain" },
  { id: "verify", title: "Verifying a proof yourself" },
  { id: "optional", title: "PostHog, AI agents and visitors" },
  { id: "alerts", title: "When something breaks" },
  { id: "endpoints", title: "Endpoint reference" },
  { id: "agents", title: "For agents" },
];

export default async function DocsPage() {
  // Same derivation as the install snippet itself. A vendor copying a command
  // off this page must reach the deployment they are reading it on, whether
  // that is production, a preview, or localhost.
  const origin =
    originFromHeaders(await headers()) ?? "https://app.letterprove.com";
  const tiers = tierLadderDocument();
  const [primaryHost, apexHost] = verificationHosts("example.com");

  return (
    <>
      <DevKeyBanner />
      <SiteHeader />

      <main className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          Documentation
        </h1>
        <p className="mt-6 leading-relaxed text-fog">
          Letterprove publishes signed, machine-readable evidence that a
          software vendor is who it says it is, backed by data: its domain,
          proven by DNS (or, more weakly, by its script on a page there); the
          business behind its own Stripe account, as Stripe has verified it; and
          how many companies were observed signing in to it. Counts, never
          names, and no payments: Stripe is read only to confirm the business.
          This page is the whole of it: how to install the script, what it
          sends, what the attestation says, what the tiers mean, and how to
          verify any of it without trusting us.
        </p>
        <p className="mt-4 leading-relaxed text-fog">
          If you are here to check somebody else&apos;s claim rather than
          publish your own, skip to{" "}
          <a href="#verify" className="text-mint hover:underline">
            verifying a proof yourself
          </a>
          . That section is the point of the product.
        </p>

        <nav className="mt-10 rounded-lg border border-edge bg-panel p-5">
          <h2 className="text-xs font-semibold tracking-widest text-fog uppercase">
            On this page
          </h2>
          <ol className="mt-3 grid gap-1.5 text-sm">
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-fog hover:text-mint">
                  <span className="mr-2 text-fog/60 tabular-nums">
                    {i + 1}.
                  </span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-12 space-y-12">
          <Section n={1} id="install" title="Install">
            <p>
              There is no Letterprove login. Letterstory is the identity
              authority for both products, so your account and your key live
              under Proofs in the Letterstory app, and everything below is
              reached from there. This site publishes the proof; it does not
              hold a session of yours.
            </p>
            <p>
              Installation is one script tag on the pages where people sign in,
              and on any page where signed-in people use the product. It has no
              dependencies, no build step, and nothing to configure beyond its{" "}
              <code>data-key</code> attribute.
            </p>
            <Snippet>
              {installSnippet(origin, "lp_live_yourslug_0123456789ab")}
            </Snippet>
            <p>
              <strong>
                Copy the snippet the Proofs tab gives you rather than this one.
              </strong>{" "}
              The real one is generated for you, with your own key, pointed at
              the origin that served it. That is not ceremony. A written-down
              host has broken collection twice: once when an install kept
              pointing at an old deployment URL after a domain move and stayed
              dead for 65 hours, and once when every vendor was handed a{" "}
              <code>cdn.letterprove.com</code> URL for a host that has never
              existed. The script is a static file served by this app at this
              app&apos;s origin and nowhere else.
            </p>
            <p>
              Both failures were silent, and that is the part worth
              understanding. The script is built so it can never break your
              page, which means a script that fails to load and a quiet weekend
              produce exactly the same thing: no events. Nobody gets an error.
              You get an empty dashboard and conclude the product does not work.
            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              The one hard rule: the domain only
            </h3>
            <p>
              You pass an email address to the script. The script splits the
              domain off in the browser and sends only the domain.{" "}
              <code>example.com</code>, never <code>someone@example.com</code>.
              The local part never enters a request body and never leaves the
              page.
            </p>
            <p>
              The domain does the entire job of attributing activity to a
              company. The local part adds nothing and carries everything:
              end-user personal data out of someone else&apos;s product, a data
              processing agreement with every vendor, and a breach story. The
              same discipline runs through the rest of the payload. No user ids,
              no cookies, no local storage, no IP address, no page URLs, no
              referrer. The one exception is agent counting, below: on a page an
              automated browser renders, the script sends that page&apos;s path
              and nothing about any person.
            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              Nothing is counted until your domain is verified
            </h3>
            <p>
              Installing the script is not enough on its own. Until you have
              proven control of the domain by DNS, the collector accepts your
              requests and records nothing. Put a TXT record on either host:
            </p>
            <Snippet>
              {primaryHost}
              {"\n"}
              {apexHost}
            </Snippet>
            <Snippet>{`${TXT_PREFIX}=<the token shown in the Proofs tab>`}</Snippet>
            <p>
              <code>{primaryHost}</code> is the primary, following the same
              convention as <code>_dmarc</code> and <code>_acme-challenge</code>
              . The apex is accepted too, because that is where people expect a
              site-verification record to go.
            </p>
            <p>
              This gate is stricter than it needs to be for tier purposes alone,
              on purpose. If an unverified vendor could collect, whoever
              registered a domain first would accumulate events, rollups and
              history on it before the real owner ever arrived. Refusing at the
              door means an impersonator accumulates nothing and the legitimate
              owner verifies into a clean slate.
            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              Which hosts are accepted
            </h3>
            <p>
              Every event is pinned to the browser&apos;s <code>Origin</code>{" "}
              header, which page script cannot override, and compared against
              the domain on your account. Any host under the domain you verified
              is accepted automatically: verify <code>example.com</code> and
              events from <code>www.example.com</code> and{" "}
              <code>app.example.com</code> count too, because the same DNS
              record covers them.
            </p>
            <p>
              A host outside it is not. A sibling or parent (
              <code>eu.example.com</code> when you verified{" "}
              <code>app.example.com</code>), or a different domain entirely,
              needs adding under <strong>Other sign-in hosts</strong>, with your
              verification record on that host or on its registrable domain. It
              is re-checked daily like your domain. If the script sees sign-ins
              from a host you have not added, the Proofs dashboard says so and
              offers to add it, so a mismatch no longer fails silently.
            </p>
            <p>
              Origin-pinning is a real constraint on a browser and no constraint
              at all on <code>curl</code>. That is a known, accepted limit
              rather than an oversight, and it is exactly why script-observed
              evidence sits low on the ladder below.
            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              Telling whether it works
            </h3>
            <p>
              Every collector response carries <Mono>x-letterprove: on</Mono>{" "}
              when the request was accepted and <Mono>off</Mono> when it was
              refused, so one <code>curl</code> answers the question instead of
              an afternoon. The body never says anything: the endpoint always
              answers <code>204</code>, including on a bad key, a malformed
              payload, an unverified domain or a rate limit, because a host page
              must never see a failure from us.
            </p>
            <p>
              The Proofs dashboard separates two questions that look identical
              from outside. <em>Installed</em> means the script has successfully
              fetched its config at least once, so it is really on the page.{" "}
              <em>Receiving</em> means an event has actually arrived. Installed
              but not receiving is normal on a marketing site with no sign-in,
              and is not a fault. While you are setting up, the dashboard
              refreshes on its own, so you see the script load and the first
              sign-in arrive as they happen.
            </p>
            <p>
              To watch it from the page itself, add <code>data-debug</code> to
              the script tag. The script then logs to the browser console when
              it boots, when <code>identify</code> is called, and when an event
              is sent or refused. Remove it when you are done.
            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              About the key
            </h3>
            <p>
              The <code>data-key</code> value is publishable, not secret. It
              ships in your page HTML by design, which is why it cannot
              authenticate anything on its own and why origin and DNS
              verification carry that weight instead. Rotating the key takes
              effect immediately and the old one stops working at once, so every
              install has to be updated in the same change.
            </p>

            <p>

              The script collects sign-ins for your proof and nothing else.

              Counting AI agents on your site and identifying visitors are a

              separate product, Visitors (lettervisit.com), with its own

              script and key.

            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              Nothing is public until you publish it
            </h3>
            <p>
              Installing the script publishes nothing. Until you publish, every
              public URL about you — <code>/proofs/&lt;you&gt;</code>,{" "}
              <code>/attest/&lt;you&gt;</code> and both chain paths — answers{" "}
              <strong>404</strong>, the same 404 a vendor who does not exist
              gets, and you are absent from the discovery document. Nobody can
              tell from the outside that you are here.
            </p>
            <p>
              Everything else runs the whole time. Events are collected, rolled
              up hourly, signed, chained and frozen exactly as they would be if
              you were public. So publishing is a switch, not a build: the day
              you turn it on, your history already reaches back to your first
              observation instead of starting that morning. Install, watch it
              work for as long as you like, and go public when the numbers are
              worth showing.
            </p>
            <p>
              Preview your proof page from the Proofs dashboard first, then
              publish and unpublish from the same place. Publishing needs your
              domain verified, because nothing is collected for an unverified
              domain and the only document we could sign for you would be a
              zero. Unpublishing takes every URL back to 404 — but it cannot
              un-fetch: an attestation someone already retrieved while you were
              public stays signed and stays verifiable, which is the whole point
              of signing it.
            </p>
          </Section>

          <Section n={2} id="client-api" title="The client API">
            <p>
              The script exposes exactly three calls on{" "}
              <code>window.Letterprove</code>. There is no fourth, and no
              general event method.
            </p>
            <Snippet>{`Letterprove.identify(email)  // establishes the domain, fires one "session" per page load
Letterprove.signup(email)    // identifies, then fires "signup"
Letterprove.login(email)     // identifies, then fires "login"`}</Snippet>
            <p>
              <code>identify</code> is what you call on an authenticated page
              load. <code>signup</code> and <code>login</code> call it
              internally before firing their own event, so an auth success
              handler never needs to call both. The <code>session</code> event
              fires at most once per page load no matter how many times you call{" "}
              <code>identify</code>.
            </p>
            <p>
              An address that cannot be split into a domain is dropped silently,
              and nothing is sent until one has been. There is no way to pass a
              domain directly: the split happens here so that the address cannot
              be sent by mistake.
            </p>
            <p>Three behaviours are worth knowing before you wire it up.</p>
            <ul>
              <li>
                <strong>It cannot throw into your page.</strong> Every public
                method is wrapped, and so is every transport path. Your product
                must behave identically whether this script loads, fails, or is
                missing.
              </li>
              <li>
                <strong>Calls made before it loads are kept.</strong> If your
                code can run before the script tag has loaded (an{" "}
                <code>async</code> tag, or a framework that hydrates first), use
                the snippet from the Proofs dashboard, which includes a one-line
                stub. The stub holds <code>identify</code>, <code>signup</code>{" "}
                and <code>login</code> calls and the script replays them once it
                starts.
              </li>
              <li>
                <strong>It fails closed.</strong> The script fetches its
                collection config once at boot. Calls made before that resolves
                are queued in memory and flushed when it does. If the fetch
                fails, the queue is dropped and the page collects nothing. It is
                never retried mid-page, because a guess is worse than a gap.
              </li>
              <li>
                <strong>
                  Transport prefers <code>sendBeacon</code>
                </strong>
                , falling back to a <code>keepalive</code> fetch. Neither is
                awaited and neither surfaces a result.
              </li>
            </ul>
            <p>
              What actually goes over the wire is five fields: your publishable
              key, the domain, the event name, the config version that produced
              it, and a client timestamp. The timestamp is used for ordering and
              de-duplication only and is never authoritative. Counting happens
              on the server against our own receipt timestamp, because a counter
              the page can set is a counter the page can inflate. We
              additionally store the request origin and a country and region
              derived at the edge.
            </p>
            <p>
              Volume is capped at 300 requests a minute per source IP and 3,000
              a minute per vendor key. Both refusals look like every other
              refusal: a <code>204</code> with <Mono>x-letterprove: off</Mono>.
            </p>
          </Section>

          <Section
            n={3}
            id="published"
            title="What a published attestation says"
          >
            <p>
              One document is published per vendor: the{" "}
              <strong>vendor attestation</strong>, at{" "}
              <code>/attest/&lt;vendor&gt;.json</code>. It says who the vendor
              is and what backs it, and it names no customer. (Per-customer
              documents were retired on 2026-10-13; their URLs answer{" "}
              <code>410</code>, and copies signed before then still verify.)
            </p>
            <p>Who the vendor is:</p>
            <ul>
              <li>
                <code>domain</code> and <code>domain_verified_since</code>: the
                domain proven by a DNS TXT record, and since when. The record is
                re-checked daily; if it stays gone, verification is cleared and
                every tier drops to 0.
              </li>
              <li>
                <code>domain_proof</code>: how the vendor&apos;s claim to{" "}
                <code>domain</code> is proven. <code>dns</code> (Verified by
                DNS) allows every tier. <code>site</code> (Site verified):
                Letterprove found the vendor&apos;s script and key on a page of
                the domain, which proves control of a page rather than the
                domain&apos;s DNS, so the tier stops at 1 and the logo wall
                doesn&apos;t count. <code>none</code> (Domain not verified): the
                counts are the vendor&apos;s claim, tier 0.{" "}
                <code>domain_verified</code> is true only for <code>dns</code>.
                DNS is optional; a vendor site-verifies with{" "}
                <code>verify_site</code>, or automatically once the script loads
                on a page of its domain.
              </li>
              <li>
                <code>hosts</code>: how many extra hosts on that domain the
                collector accepts events from. A count, never the hosts.
              </li>
              <li>
                <code>stripe_account_bound</code> and{" "}
                <code>stripe_binding</code>: whether the connected Stripe
                account is the vendor&apos;s own. <code>domain_match</code>{" "}
                means a domain the account publishes (business website, support
                email, account email) shares the vendor&apos;s verified domain;{" "}
                <code>staff_override</code> means Letterprove staff approved a
                related company&apos;s account, such as a parent company&apos;s
                account for a subsidiary.
              </li>
              <li>
                <code>stripe_business</code>: what the vendor&apos;s own Stripe
                account says about the business, read directly from Stripe.{" "}
                <code>verified</code> is true when Stripe lets the account
                accept payments, which Stripe allows only after verifying the
                business (its legal entity, the people behind it and a bank
                account). <code>name</code>, <code>country</code> and{" "}
                <code>website</code> are as the account shows them, and{" "}
                <code>website_matches_domain</code> says whether that website is
                on the vendor&apos;s domain. This is identity only: Letterprove
                reads no payments, invoices or subscriptions, and publishes no
                revenue figure.
              </li>
            </ul>
            <p>
              What backs it, over the last <code>window_days</code> (30):
            </p>
            <ul>
              <li>
                <code>companies_observed</code>: distinct company email domains
                seen signing in. It means exactly that. A session from an
                address at a company proves somebody there used the product; it
                does not prove the company buys it. Free mail and the
                vendor&apos;s own domains are counted separately as{" "}
                <code>domains_excluded</code> rather than silently dropped.
              </li>
              <li>
                <code>growth</code>: companies observed per month for up to six
                months, from Letterprove&apos;s own signed history. A month
                marked <code>partial</code> had less than a full 30-day window
                of observation behind it, so its count is lower partly because
                observation had just begun. A month marked{" "}
                <code>in_progress</code> is still under way; its count can only
                rise. <code>retention</code>: of the companies observed from 90
                to 60 days ago, how many were also observed in the last 30 days.
                Both are counts and never change the tier.
              </li>
              <li>
                <code>sessions</code>, <code>signups</code>, <code>logins</code>
                : measured totals behind those companies.
              </li>
              <li>
                <code>logos</code>, when present: the vendor&apos;s own public
                logo wall, checked. <code>page</code> is the page,{" "}
                <code>listed</code> the companies the vendor declared,{" "}
                <code>on_page</code> how many were found on that page, and{" "}
                <code>verified</code> how many of those Letterprove observed
                signing in over the last 30 days. Only verified companies are
                named. It never moves the tier.
              </li>
              <li>
                <code>reported_history</code>, when present: company history
                from the vendor&apos;s own PostHog project, read only, as counts
                (<code>companies</code>, <code>since</code>,{" "}
                <code>active_companies_30d</code>,{" "}
                <code>observed_also_reported</code>). It is listed in{" "}
                <code>vendor_stated</code> because the vendor controls that
                project, and it never moves the tier. It is published only while
                the project records traffic on the vendor&apos;s own hosts.
              </li>
              <li>
                <code>observed_since</code>: when Letterprove first observed
                usage for this vendor, from its own frozen record.
              </li>
              <li>
                <code>vendor_stated</code> lists any field that is the
                vendor&apos;s statement rather than evidence. It is empty unless{" "}
                <code>reported_history</code> is present, and then it names that
                field.
              </li>
              <li>
                <code>hidden_by_vendor</code> lists the optional sections the
                vendor chose not to show, and <code>omitted</code> gives the
                reason every optional field is absent: <code>hidden</code>,{" "}
                <code>insufficient_history</code>, <code>not_connected</code>,{" "}
                <code>not_configured</code> or <code>domain_not_verified</code>.
                Absent never means zero.
              </li>
              <li>
                Documents signed before the 2026-10-14 change may carry{" "}
                <code>paying_since</code>, <code>payment_scope</code>,{" "}
                <code>paying</code>, and logo <code>paying</code> counts:
                payment fields from when Stripe payments were still read. They
                describe that snapshot only.
              </li>
              <li>
                <code>observed_through</code> is the end of the window
                summarised. <code>published_at</code> is when the snapshot was
                cut. They are deliberately separate.
              </li>
              <li>
                <code>method</code> is a commit-pinned link to the source file
                that computed the numbers. Nothing else in the document asks to
                be trusted.
              </li>
              <li>
                <code>prev_hash</code> is the SHA-256 of the previous signed
                snapshot for the same vendor, with 64 zeroes at the start of a
                chain. This is what makes the history auditable rather than
                merely signed.
              </li>
            </ul>
            <p>
              Signing runs on a cadence, not per request. Rollups are written
              hourly on the hour, and the freeze that signs, chains and
              countersigns them runs five minutes later. A new snapshot is cut
              every {SNAPSHOT_CADENCE_SECONDS / 60} minutes, and each one says
              when the next is due in <code>next_snapshot_at</code>. A snapshot
              does not expire: it is a signed statement about the window ending{" "}
              <code>observed_through</code>, and it stays true and verifiable
              permanently. A newer one supersedes it. Snapshots signed before
              2026-10-08 carry a <code>ttl</code> instead, which was only ever a
              cache hint.
            </p>
          </Section>

          <Section n={4} id="tiers" title="The tier ladder">
            <p>{tiers.note}</p>
            <div className="grid gap-2">
              {tiers.levels.map((level) => (
                <div
                  key={level.tier}
                  className="rounded border border-edge bg-ink/40 px-4 py-3"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs text-mint">
                      tier {level.tier}
                    </span>
                    <span className="font-medium text-[#e9efed]">
                      {level.name}
                    </span>
                  </div>
                  <p className="mt-1 text-sm">{level.means}</p>
                  <p className="mt-1.5 text-sm">
                    <span className="text-fog/70">Forgeable by:</span>{" "}
                    {level.forgeable_by}
                  </p>
                </div>
              ))}
            </div>
            {tiers.retired.map((level) => (
              <p key={level.tier} className="text-sm text-fog">
                Retired: tier {level.tier}, {level.name}. {level.means}{" "}
                <span className="text-fog/70">Forgeable by:</span>{" "}
                {level.forgeable_by}
              </p>
            ))}
            <p>
              That list is rendered from the same definition the discovery
              document publishes, so this page cannot describe a ladder we do
              not serve.
            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              The tier comes from evidence, never from you
            </h3>
            <p>
              Nobody sets a tier, you included. It is derived each hour from the
              evidence, and it describes the vendor&apos;s evidence as a whole:
              the strongest class present, published beside the counts it rests
              on. In this order:
            </p>
            <ul>
              <li>
                If you have not proven your domain at all, the published tier is
                0, whatever was observed: an observation on a domain nobody has
                proven is only the vendor asserting. Proof is by DNS, or more
                weakly by your script and key on a page of the domain (site
                proof, which stops at tier 1). Both are re-checked daily; a
                proof that stays gone is cleared.
              </li>
              <li>
                If no company was observed in the window, the published tier is
                0. A tier is a statement about evidence, and there is none.
              </li>
              <li>
                If companies were observed signing in on your proven domain, the
                tier is 1: evidence, but evidence you could fabricate with
                effort.
              </li>
              <li>
                If your domain is proven by DNS and Stripe has verified the
                business behind your own Stripe account, with its website on
                your domain (or an account Letterprove staff approved), the tier
                is 3. Tier 3 says who you are. It says nothing about payments,
                which Letterprove does not read.
              </li>
            </ul>
            <p>
              Tier 2 is not issued. It is reserved for observations bound to
              network facts you do not choose (the spread of networks, by ASN,
              that sign-ins arrive from), and that binding is not built.
              Documents signed before 2026-10-13 may carry tier 2 for evidence
              that met only the tier-1 bar; read them as tier 1.
            </p>
            <p>
              An unmeasurable window fails toward the weaker claim rather than
              the stronger one. A failed telemetry read, an unconfigured
              datastore and a genuinely empty window all leave the same mark:
              not observed, so tier 0.
            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              Tier 3: Stripe confirms who you are
            </h3>
            <p>
              <strong>Stripe is used for one thing:</strong> confirming that you
              are a real, verified business at your domain. You connect a
              restricted key with a single permission,{" "}
              <strong>Accounts read</strong> (Stripe lists it under{" "}
              <strong>Connect</strong> in the key editor). Letterprove reads the
              account itself and nothing else: no payments, invoices,
              subscriptions or products, and no revenue figure is ever
              published.
            </p>
            <p>
              From the account we read whether Stripe lets it accept payments,
              which Stripe turns on only after verifying the business (its legal
              entity, the people behind it and a bank account), plus the
              business name, country and website it shows. The account has to be
              yours: one of the domains it publishes (business website, support
              email) must share your domain, or the key is refused. If a related
              company holds the account, for example a parent, use{" "}
              <strong>Request review</strong> in the Stripe panel and we will
              look at it; an approval is stated in <code>stripe_binding</code>.
            </p>
            <p>
              Tier 3 needs all of it at once: companies observed on a domain
              proven by DNS, a live-mode key, Stripe&apos;s verification, and
              the account&apos;s website on your domain (or a staff approval). A
              test-mode key reads the account but never counts as verified. The
              account is re-read hourly; if reads keep failing, the recorded
              business is cleared, so revoking your key cannot freeze a
              favourable answer in place.
            </p>
            <p>
              The honest limit:{" "}
              <strong>tier 3 confirms identity, not usage or revenue.</strong> A
              real, Stripe-verified business can still script sign-ins (see tier
              1). Read tier 3 as a third party vouching for who you are.
              Documents signed before the 2026-10-14 change without{" "}
              <code>stripe_business</code> used tier 3 for payment from an
              observed company; read them as describing that snapshot.
            </p>
          </Section>

          <Section n={5} id="customers" title="Your customers stay private">
            <p>
              Letterprove never contacts your customers, and never names them
              unless you opt in to logo verification, which names only companies
              already on your own public logo wall that we observed signing in.
              Otherwise the attestation carries counts only. Company domains are
              used inside Letterprove only to count distinct companies and to
              check your logo wall.
            </p>
            <p>
              You can see the domains behind your own counts on the{" "}
              <strong>Observed</strong> tab. Only you see them. Nothing there is
              published, and nothing there changes a figure: the attestation
              counts what was observed.
            </p>
            <p>
              Per-customer documents, which named a company when the vendor said
              it had permission, were retired on 2026-10-13. Their URLs answer{" "}
              <code>410</code>; copies signed before then still verify against
              the published keys.
            </p>
          </Section>

          <Section n={6} id="showing" title="Badge and your own domain">
            <p>
              <strong>The footer badge.</strong> Once your proofs are public,
              the Proofs dashboard gives you a small &ldquo;Attested and proven
              by Letterprove&rdquo; badge to paste into your site&apos;s footer.
              It is self-contained HTML that loads nothing, inherits your
              footer&apos;s colour, and links to your public proof page. Until
              your proofs are published it would link to a page that answers
              404, so the dashboard holds it back until you publish. You also
              get a short paragraph to post with the link.
            </p>
            <p>
              <strong>Your proof page on your own domain.</strong> You can serve
              the same page at a subdomain of the domain you verified, such as{" "}
              <code>proof.yourcompany.com</code>. Set it under{" "}
              <strong>Your own domain</strong> on the Proofs dashboard, add the
              one CNAME record it shows you at your DNS provider, then check
              again. It has to sit under your verified domain, so nobody can
              claim a hostname that belongs to another company, and it cannot be
              the bare domain itself, because a CNAME cannot sit there.
            </p>
            <p>
              Nothing about the proof changes on your domain. It is the same
              page and the same signed documents, and every verify link still
              points at Letterprove, so a proof served from your domain stays
              something a reader can check rather than something you published
              about yourself. Until your proofs are public, the subdomain
              answers 404.
            </p>
          </Section>

          <Section n={7} id="verify" title="Verifying a proof yourself">
            <p>
              Nothing on this site asks you to trust it. The verifier is a
              single standalone script with no dependencies, using only Node
              built-ins, short enough to read before you run it.
            </p>
            <p>
              It <strong>deliberately shares no code with this service</strong>.
              It re-implements canonicalisation and signature checking from the
              published description rather than importing ours, because a
              verifier built on the producer&apos;s own canonicaliser cannot
              detect the one bug that matters, which is the producer and the
              specification disagreeing. Agreement between two independent
              implementations is the only agreement worth anything here.
            </p>
            <p>
              Fetch what you want to check, and the keys it claims to be signed
              with:
            </p>
            <Snippet>{`curl -s ${origin}/attest/<vendor>/chain > chain.json
curl -s ${VERIFY_ORIGIN}/.well-known/letterprove-jwks.json > jwks.json`}</Snippet>
            <p>
              Then run the verifier over them, from a checkout of the
              repository:
            </p>
            <Snippet>{`git clone https://github.com/letterstory/Letterprove
cd Letterprove
npm run verify -- ./chain.json --jwks ./jwks.json`}</Snippet>
            <p>
              There is nothing to install first. The script imports only Node
              built-ins, so a clone is enough, and{" "}
              <code>node scripts/verify.mjs</code> works just as well as the npm
              script. It also takes URLs directly. Wherever the proof came from,
              it fetches the keys from app.letterprove.com, never from the host
              that served the document, because a host that can serve a forged
              proof can serve forged keys beside it. Pass <code>--jwks</code>{" "}
              only to check against a copy you already hold:
            </p>
            <Snippet>{`npm run verify -- ${origin}/attest/<vendor>/chain`}</Snippet>
            <p>
              Point it at a <strong>chain</strong> rather than a single
              document. A lone attestation is a window into a history, and its{" "}
              <code>prev_hash</code> has nothing to be checked against; given
              the chain, the verifier checks every link.
            </p>
            <p>For each entry in the chain it does three things:</p>
            <ul>
              <li>
                Canonicalises every field except the signature. Object keys
                sorted, array order preserved, integers only. A non-integer
                number is a hard error rather than a rounding, because floats
                would break byte agreement between two implementations.
              </li>
              <li>
                Finds the published key whose id matches the document&apos;s{" "}
                <code>key_id</code> and checks the Ed25519 signature over those
                exact bytes. Retired keys are published forever, so an old proof
                still verifies years after its key leaves rotation.
              </li>
              <li>
                Recomputes the hash of the entry and checks the next
                entry&apos;s <code>prev_hash</code> against it, starting from 64
                zeroes.
              </li>
            </ul>
            <p>
              It then prints the provenance tier from the head of the chain, the{" "}
              <code>method</code> link, and a warning if anything in the chain
              was signed with a development key. It exits non-zero if any entry
              failed.
            </p>

            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              What agreement proves
            </h3>
            <p>
              A passing run proves two things and no more:{" "}
              <strong>
                this document is ours, and it has not been altered since we
                signed it
              </strong>
              , and the history behind it has not been quietly restated.
            </p>
            <p>
              It proves nothing whatsoever about how good the underlying
              evidence is.{" "}
              <strong>The tier says that, and the tier is the claim.</strong> A
              perfectly valid signature over a tier-0 body asserts only that the
              vendor said so. This is the more dangerous direction of failure:
              an agent that cannot read the tier does not distrust us, it
              over-trusts us, verifying a signature and reporting
              &ldquo;attested&rdquo; about a sentence the vendor typed. Read
              both, always.
            </p>
            <p>
              One more warning to take seriously. Anything signed by a
              development key is a demonstration and not evidence, because the
              development key is published and anyone can forge under it.
              Development deployments say so in a banner, in the discovery
              document, in the key id, and in the verifier&apos;s own output.
            </p>
            <p className="pt-1">
              <Link href="/verify" className="text-mint hover:underline">
                The verify page
              </Link>{" "}
              renders the live discovery document, and{" "}
              <Link href="/keys" className="text-mint hover:underline">
                the keys page
              </Link>{" "}
              renders the current JWKS, if you would rather read either in prose
              first.
            </p>
          </Section>

          <Section n={8} id="optional" title="PostHog, AI agents and visitors">
            <p>Three optional additions. None of them changes your tier.</p>
            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              Company history from PostHog
            </h3>
            <p>
              If you use PostHog, the <strong>Company history</strong> panel
              reads how long companies have been using your product, from before
              you installed the script. Letterprove only reads; it never sends
              anything to PostHog. Create a personal API key with project access
              to your product&apos;s project,
              <strong>Product analytics: Read</strong> and
              <strong>Events, people &amp; data model: Read</strong>, and
              nothing else.
            </p>
            <p>
              Once a day we read which company email domains PostHog has
              identified people from, since when, and how active each was in the
              last 30 days. The split from address to domain happens inside
              PostHog, so no address or name reaches us. Your attestation
              carries it as <code>reported_history</code>, labelled as your
              statement, and only while the project records traffic on your
              verified domain. It also says how many of the companies we
              observed ourselves appear in that history.
            </p>
            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              Verify your logos
            </h3>
            <p>
              If your site shows customer logos, list them in the{" "}
              <strong>Logos</strong> panel with the page they appear on. We
              fetch that page daily and keep only the companies actually on it.
              Your proof then names the ones we observed signing in over the
              last 30 days, and shows how many of your logos are verified. This
              is the only place a proof names a company, and only one you
              already show in public.
            </p>
            <h3 className="pt-2 text-lg font-medium text-[#e9efed]">
              Add your proof to your site
            </h3>
            <p>
              AI assistants read your site, not ours. After you publish, add the
              three snippets from setup: a footer link (&ldquo;For agents: view
              attested customer proof&rdquo;), a Customer evidence section for
              your <code>/llms.txt</code>, and a small JSON-LD block for your
              homepage. Each points at your proof.
            </p>
          </Section>

          <Section n={9} id="alerts" title="When something breaks">
            <p>
              We email the people on your account when something needs
              attention, with what happened and how to fix it:
            </p>
            <ul>
              <li>your DNS verification record can&apos;t be found;</li>
              <li>nothing has been collected for two days;</li>
              <li>your Stripe or PostHog sync keeps failing.</li>
            </ul>
            <p>
              The script never surfaces an error on your page, so these emails
              and the dashboard are how you find out.
            </p>
          </Section>

          <Section n={10} id="endpoints" title="Endpoint reference">
            <p>
              Every proof endpoint is public, unauthenticated and CORS-open,
              answers JSON as UTF-8, and carries <Mono>x-letterprove: on</Mono>.
              A proof nobody can fetch cross-origin is not proof.
            </p>
            <p>
              All of them resolve only once you have{" "}
              <a href="#install" className="text-mint hover:underline">
                published
              </a>
              . Before that they answer 404, indistinguishably from a vendor who
              does not exist.
            </p>
            <Endpoints origin={origin} />
            <p>
              <code>/proofs/&lt;vendor&gt;</code> is content-negotiated. A
              browser gets the human page; a <code>.json</code> suffix or an
              explicit JSON <code>Accept</code> with no HTML alternative gets
              the machine document, which carries the summary, the signed vendor
              attestation, and the tier ladder inline so an agent that landed
              there directly can weight what it reads without a second fetch.{" "}
              <code>/attest/&lt;vendor&gt;</code> accepts a <code>.json</code>{" "}
              suffix as well, for clients that cannot set a header.
            </p>
            <p>
              The two collection endpoints are called by the script, not by you.
              They live under <code>/api/v1/</code>, and both answer with the
              diagnostic header described in the install section.
            </p>
            <Snippet>{`GET  ${origin}/api/v1/config?k=<publishable key>
POST ${origin}/api/v1/observe`}</Snippet>
            <p>
              Start from{" "}
              <a
                href="/.well-known/letterprove.json"
                className="text-mint hover:underline"
              >
                the discovery document
              </a>{" "}
              if you are writing an agent. It is built by the same function that
              renders the verify page, and it carries the signing algorithm and
              mode, the JWKS location, a commit-pinned link to the
              canonicalisation rules, a link to the verifier, the full tier
              ladder, and every published proof with its aggregate and chain
              URLs. One fetch gets you from &ldquo;this host publishes
              proof&rdquo; to a verified claim without reading any of this page.
            </p>
          </Section>

          <Section n={11} id="agents" title="For agents">
            <p>
              Everything the Proofs dashboard does is also a tool your own agent
              can call, through the Letterstory MCP server (the same names with
              a <code>letterprove_</code> prefix). The ones behind the panels on
              this page:
            </p>
            <ul>
              <li>
                Setup: <code>create_vendor</code>, <code>verify_domain</code>,{" "}
                <code>get_install_snippet</code> (the snippet, the badge and{" "}
                <code>server_snippet</code>), <code>get_status</code>,{" "}
                <code>rotate_key</code>.
              </li>
              <li>
                Hosts: <code>add_host</code>, <code>remove_host</code>,{" "}
                <code>list_hosts</code>.
              </li>
              <li>
                Stripe: <code>connect_stripe</code>,{" "}
                <code>get_stripe_connection</code>,{" "}
                <code>refresh_stripe_business</code>,{" "}
                <code>disconnect_stripe</code>.
              </li>
              <li>
                PostHog: <code>connect_posthog</code>,{" "}
                <code>get_posthog_connection</code>, <code>sync_posthog</code>,{" "}
                <code>disconnect_posthog</code>.
              </li>
              <li>
                Publishing and your own domain: <code>publish_proofs</code>,{" "}
                <code>unpublish_proofs</code>, <code>set_proof_listing</code>, <code>set_custom_domain</code>,{" "}
                <code>check_custom_domain</code>,{" "}
                <code>remove_custom_domain</code>.
              </li>
              <li>
                What was observed: <code>list_observed</code>,{" "}
                <code>get_proof_summary</code>, <code>list_snapshots</code>.
              </li>
              <li>
                Help: <code>submit_support_request</code>.
              </li>
            </ul>
            <p>
              Every tool is scoped to the vendor of the token calling it. The
              two that take a secret, <code>connect_stripe</code> and{" "}
              <code>connect_posthog</code>, never return it.
            </p>
          </Section>
        </div>

        <div className="mt-16 border-t border-edge pt-8 text-sm text-fog">
          <p>
            Something here disagreeing with what the service actually does is a
            bug. The code is{" "}
            <a
              href="https://github.com/letterstory/Letterprove"
              rel="noreferrer"
              className="text-mint hover:underline"
            >
              open
            </a>
            , and it is the authority.{" "}
            <Link href="/privacy" className="text-mint hover:underline">
              Privacy Policy
            </Link>{" "}
            ·{" "}
            <Link href="/terms" className="text-mint hover:underline">
              Terms of Service
            </Link>
          </p>
        </div>
      </main>

      <SiteFooter />
    </>
  );
}

/**
 * Prose styling matches the legal pages rather than the dashboard cards: this
 * is read start to finish, not scanned.
 */
function Section({
  n,
  id,
  title,
  children,
}: {
  n: number;
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="text-2xl font-semibold tracking-tight">
        <span className="mr-2 text-fog/70">{n}.</span>
        {title}
      </h2>
      <div className="mt-4 space-y-4 leading-relaxed text-fog [&_code]:rounded-sm [&_code]:bg-ink [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_li]:leading-relaxed [&_strong]:font-semibold [&_strong]:text-[#e9efed] [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
        {children}
      </div>
    </section>
  );
}

/** Horizontal scroll lives on the block, never on the page. */
function Snippet({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded border border-edge bg-ink p-4 font-mono text-sm whitespace-pre text-mint">
      {children}
    </pre>
  );
}

function Endpoints({ origin }: { origin: string }) {
  const rows: { path: string; serves: string }[] = [
    {
      path: "/proofs/<vendor>",
      serves: "The vendor report, as a page or as JSON",
    },
    {
      path: "/attest/<vendor>",
      serves: "The vendor attestation: identity and evidence. Counts, no names",
    },
    {
      path: "/attest/<vendor>/chain",
      serves: "Its full signed history, oldest first",
    },
    {
      path: "/attest/<vendor>/<customer>",
      serves:
        "Retired 2026-10-13: answers 410. Per-customer documents are no longer published",
    },
    { path: "/.well-known/letterprove.json", serves: "Discovery. Start here" },
    {
      path: "/.well-known/letterprove-jwks.json",
      serves: "Every public key a proof here has ever been signed with",
    },
    { path: ATTEST_SCRIPT_PATH, serves: "The collection script itself" },
  ];

  return (
    <div className="overflow-x-auto rounded-lg border border-edge bg-panel">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="border-b border-edge bg-ink/40 px-4 py-2.5 text-left text-[11px] font-semibold tracking-widest text-fog uppercase whitespace-nowrap">
              Path
            </th>
            <th className="border-b border-edge bg-ink/40 px-4 py-2.5 text-left text-[11px] font-semibold tracking-widest text-fog uppercase">
              Serves
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path}>
              <td className="border-b border-edge/60 px-4 py-3 align-top font-mono text-[13px] whitespace-nowrap text-[#e9efed]">
                {row.path}
              </td>
              <td className="border-b border-edge/60 px-4 py-3 align-top text-fog">
                {row.serves}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-3 text-xs text-fog">
        All relative to <span className="font-mono">{origin}</span>, the
        deployment serving this page.
      </p>
    </div>
  );
}
