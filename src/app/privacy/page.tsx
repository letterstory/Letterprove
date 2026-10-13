import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";

export const metadata: Metadata = {
  title: "Privacy Policy — Letterprove",
  description:
    "What Letterprove collects when its script runs on a customer's site, why it is company-level rather than personal, and what is published.",
};

const UPDATED = "October 13, 2026";

/**
 * Written against what the code actually does, not against the sibling
 * product's policy. Every factual claim here maps to something checkable:
 *
 *   §2  src/lib/telemetry/record.ts — the exact column list written per event
 *   §3  src/app/api/v1/observe/route.ts — origin pinning, DNS verification gate
 *   §4  src/lib/attest/aggregate.ts — the only published document: counts, no names
 *   §6  src/lib/db/client.ts — RLS, service-role isolation
 *
 * If one of those changes, this page is wrong and has to change with it. The
 * riskiest one is §2, which is why the location disclosure there was published
 * BEFORE the code that collects it rather than alongside — the commitment the
 * previous revision made was "before we start collecting, not afterwards", and
 * shipping both in one deploy would have honoured the letter of that and not
 * the point of it.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated={UPDATED}
      intro="Letterprove is operated by The Letter Company. It publishes cryptographically signed evidence that a company's software is really used. This policy explains what we observe when our script runs on a customer's website, what we store, and what we publish — and why almost none of it is personal data."
    >
      <Section n={1} title="The short version">
        <p>
          Letterprove has two kinds of people in it: <strong>vendors</strong>,
          who sign up and install our script on their own site, and{" "}
          <strong>the visitors to those sites</strong>, who never interact with
          us directly.
        </p>
        <p>
          For vendors, we hold an account and the configuration you enter. For
          visitors, we record{" "}
          <strong>
            the company domain, and the country and region a request came from
          </strong>{" "}
          — never a name, never an email address, never an IP address, and no
          cookies. We do not set anything on your device, and there is nothing
          on a vendor&apos;s site that identifies you personally to us.
        </p>
        <p>
          One exception is opt-in and belongs to the vendor: a vendor can turn
          on <strong>visitor identification</strong>, which has our script also
          load a third-party visitor identification pixel on that vendor&apos;s own site
          (see section 7). It is separate from the evidence we publish and
          never appears in it.
        </p>
      </Section>

      <Section n={2} title="What the script records">
        <p>
          When someone signs up, logs in, or starts a session on a vendor&apos;s
          site, the Letterprove script sends us a single small message. It
          contains exactly five things, and we store one more:
        </p>
        <ul>
          <li>
            <strong>The vendor</strong> whose site it came from.
          </li>
          <li>
            <strong>The email domain</strong> — <code>acme.com</code>, or{" "}
            <code>gmail.com</code>. The domain only. Not the address, not the
            local part, not a hash of either.
          </li>
          <li>
            <strong>The kind of event</strong> — one of <code>session</code>,{" "}
            <code>signup</code>, or <code>login</code>. Nothing else is a valid
            event.
          </li>
          <li>
            <strong>A configuration version number</strong>, so we can tell old
            installs from new ones.
          </li>
          <li>
            <strong>The origin the request came from</strong>, as the browser
            reported it.
          </li>
          <li>
            <strong>Our own receipt timestamp</strong>, taken from our server
            rather than from the message, so it cannot be backdated.
          </li>
        </ul>
        <p>
          That is the complete list from the script. It does not send us names, email addresses,
          IP addresses, user identifiers, device fingerprints, page URLs, form
          contents, or behavioural data, and we set no cookies and no local
          storage. A domain like <code>gmail.com</code> tells us nothing about a
          person; a domain like <code>acme.com</code> identifies a{" "}
          <em>company</em>, which is the entire point of the product.
        </p>
        <p>
          <strong>One exception, for automated visitors only.</strong> When the
          visitor is an AI agent or an automated browser (the browser says it
          is automated, or its user-agent names an agent), the script sends one
          extra message with the page path, without its query string. A vendor
          can also have its own server forward the same for agents that never
          run scripts. We keep a daily count per agent and path for that
          vendor, and no IP address or raw user-agent. People browsing normally
          never trigger it.
        </p>
        <p>
          <strong>If a vendor connects PostHog</strong>, we read, with a
          read-only key the vendor supplies, which company email domains the
          vendor&apos;s own PostHog project has identified people from, since
          when, and how active each was in the last 30 days. The split from
          address to domain happens inside PostHog, so no address, name or
          person identifier reaches us. We never send anything to PostHog.
        </p>
        <p>
          <strong>If a vendor connects Stripe</strong>, we read invoices and
          customer records from the vendor&apos;s own Stripe account, with a
          read-only key the vendor supplies. Those records include the billing
          email address of each of the vendor&apos;s paying customers. We read
          that address only to take its domain, in memory, during the sync; we
          store the domain and the amount paid, never the address.
        </p>
        <p>
          <strong>If this changes, this page changes first.</strong> This is
          that change, made before the collection starts rather than after it.
        </p>
        <p>
          <strong>Approximate location, starting shortly.</strong> To detect
          fabricated traffic we are adding two more fields to the list above:
          the <strong>country</strong> and the{" "}
          <strong>first-level region</strong> (a state or equivalent) that a
          request arrived from, as our hosting provider reports them from the
          network. Real usage by real companies comes from many places; traffic
          invented to look like customers usually comes from one. That
          difference is only visible if we record roughly where requests came
          from.
        </p>
        <p>
          This is deliberately the coarsest form of that signal. We do{" "}
          <strong>not</strong> record the city, the latitude and longitude, the
          postal code, or the IP address itself, even though our hosting
          provider offers all of them — a region contains millions of people and
          identifies none of them, and the extra precision would buy us nothing
          a spoofer couldn&apos;t defeat anyway.
        </p>
        <p>
          We considered recording the network operator each request came from,
          which is the sharper signal because it distinguishes a data centre
          from a home connection. We are not doing it: it would mean either
          shipping a commercial address database or sending every visitor&apos;s
          IP address to a third-party lookup service, and the second of those is
          a far larger disclosure than the problem justifies.
        </p>
      </Section>

      <Section n={3} title="What we refuse to record">
        <p>
          Two checks run before anything is stored, and both fail closed — a
          rejected event is discarded, not queued:
        </p>
        <ul>
          <li>
            The request must come from the vendor&apos;s own domain. An event
            claiming to be from a site it did not come from is dropped.
          </li>
          <li>
            The vendor must have proven control of that domain by publishing a
            DNS record we specify. Until they do,{" "}
            <strong>nothing they send is stored at all</strong> — so nobody can
            accumulate a history on a domain they do not own.
          </li>
        </ul>
      </Section>

      <Section n={4} title="What we publish, and what we never publish">
        <p>
          Letterprove is a publishing product, so this section matters more than
          it usually would.
        </p>
        <p>
          <strong>Counts about the vendor are public.</strong> A vendor&apos;s
          proof shows that it controls its domain, whether its Stripe account
          is its own, and totals — how many companies were observed, how many
          of them pay, how many sessions. These name nobody.
        </p>
        <p>
          <strong>No customer is ever named.</strong> Letterprove does not
          publish, or contact, any of a vendor&apos;s customers. Company domains
          are used inside Letterprove only to join observed usage to the
          vendor&apos;s Stripe payments. Attestations that named individual
          customers were retired on October 13, 2026.
        </p>
        <p>
          We never publish individual events, individual visitors, or the raw
          domain list. The per-domain view exists only inside the vendor&apos;s
          own dashboard and our internal staff tools.
        </p>
      </Section>

      <Section n={5} title="Vendor account information">
        <p>
          Letterprove holds no vendor identity of its own — signing in and
          organization membership are handled entirely by Letterstory, which
          Letterprove trusts as an authenticated peer. We do not store a
          vendor password or password hash. We do store what you enter about
          your company, and any private customer list you keep (names,
          domains, start dates, notes). That list is never published.
        </p>
        <p>
          Your publishable key is not a secret. It ships in your page&apos;s
          HTML by design, which is why the domain checks in §3 exist — the key
          alone cannot authorise anything.
        </p>
      </Section>

      <Section n={6} title="Security">
        <p>
          <strong>
            Data is isolated per account by Postgres Row Level Security
          </strong>
          , enforced by the database rather than only by application code.
          Observation tables carry no access policies at all, so only our own
          backend can read them.
        </p>
        <p>
          <strong>Published attestations are signed with an Ed25519 key</strong>{" "}
          and chained to the one before, so a published claim cannot be altered
          after the fact without breaking the chain. Anyone can verify this
          independently — the verifier is open source and re-implements the
          check rather than importing ours.
        </p>
        <p>
          Traffic is encrypted in transit over TLS. No system is perfectly
          secure.
        </p>
      </Section>

      <Section n={7} title="Service providers">
        <p>We keep this list short deliberately. Letterprove uses:</p>
        <ul>
          <li>
            <strong>Supabase</strong> — database.
          </li>
          <li>
            <strong>Vercel</strong> — application hosting.
          </li>
          <li>
            <strong>Letterstory</strong> — vendor sign-in and organization
            membership. Letterprove holds no identity of its own; see §5.
          </li>
          <li>
            <strong>Stripe</strong> — reads a vendor&apos;s own connected
            account, at their instruction, to corroborate a customer&apos;s
            settled invoices for a higher provenance tier. We do not process
            payments and do not receive card data.
          </li>
          <li>
            <strong>Slack</strong> — internal alerting for our own team; no
            vendor or visitor data is routed through it.
          </li>
          <li>
            <strong>A visitor identification provider</strong> — identifies the companies
            and business contacts that visit our marketing site,
            letterprove.com, and, for vendors who turn on visitor
            identification, that vendor&apos;s own site.
          </li>
        </ul>
        <p>
          Our marketing site, letterprove.com, uses a third-party identification provider to
          identify the companies and business contacts that visit it. The
          Letterprove app, proof pages and attestation documents do not use any
          de-anonymisation service.
        </p>
        <p>
          The collector script on a vendor&apos;s site does not either, unless
          that vendor turns on <strong>visitor identification</strong>. Then
          the script also loads a third-party identification provider&apos;s
          pixel on the vendor&apos;s own site, and that provider identifies the companies and
          business contacts visiting it. The vendor sees those visitors in its
          private dashboard. Letterprove pulls them live from the provider each time
          the vendor looks and does not store them; they are never published,
          never signed, and never counted in any proof. Letterprove&apos;s own
          collection stays as described in section 2: a company domain, never a
          person. A vendor who turns this on is responsible for disclosing it in
          its own privacy policy.
        </p>
        <p>
          We do not use advertising trackers, we do not sell information, and we
          do not build behavioural profiles.
        </p>
      </Section>

      <Section n={8} title="Who is responsible for what">
        <p>
          A vendor decides to install our script and decides which of their
          customers to record. For that data, Letterprove acts on the
          vendor&apos;s instructions rather than deciding independently what to
          do with it. We have not yet formalized this in a signed data
          processing agreement; if your organization requires one before you
          can use Letterprove, contact us at the address below. If you are a
          visitor to a vendor&apos;s site and want to know why your company
          domain was observed, the vendor is the right first contact — though
          you are welcome to reach us directly and we will help.
        </p>
      </Section>

      <Section n={9} title="Retention and deletion">
        <p>
          Raw observations — the individual events our script sends — are
          deleted after 35 days. What we keep for as long as the vendor&apos;s
          account is active are hourly counts per company domain, which carry no
          per-person data, and the signed attestations built from them, because
          the published history is cumulative and a signed chain cannot be
          silently rewritten.
        </p>
        <p>
          Vendors can delete customer records from their dashboard at any time,
          which removes them from future publication. To delete an account and
          its underlying data, write to us and we will action it.
        </p>
      </Section>

      <Section n={10} title="Changes to this policy">
        <p>
          We will update the date at the top when this changes, and for material
          changes — such as collecting a category of data not listed in §2 — we
          will make a reasonable effort to notify vendors before it takes
          effect.
        </p>
      </Section>

      <Section n={11} title="Contact">
        <p>
          Questions about this policy, or a request about data concerning you:{" "}
          <a href="mailto:support@letterbrace.com">support@letterbrace.com</a>
        </p>
      </Section>
    </LegalPage>
  );
}
