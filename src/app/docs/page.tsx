import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import Link from "next/link";
import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { Mono } from "@/components/ui";
import { TTL_SECONDS } from "@/lib/attest/body";
import { tierLadderDocument } from "@/lib/attest/tiers";
import { CONSENT_REASK_COOLDOWN_MS } from "@/lib/vendors/consent-cooldown";
import { ATTEST_SCRIPT_PATH, installSnippet, originFromHeaders } from "@/lib/vendors/install";
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
 * What is deliberately NOT dressed up: seats_active is always 0, `features`
 * and `since` are vendor-asserted, tier 3 has never run against a live-mode
 * Stripe key, and the tier-3 section says out loud what a determined vendor
 * can still do. A page that reads better than the system behaves is the one
 * failure this product cannot afford.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Docs — Letterprove",
	description:
		"How to install Letterprove, what the tiers mean, how consent works, and how to verify any published attestation yourself.",
};

const SECTIONS = [
	{ id: "install", title: "Install" },
	{ id: "client-api", title: "The client API" },
	{ id: "published", title: "What a published attestation says" },
	{ id: "tiers", title: "The tier ladder" },
	{ id: "consent", title: "Consent and naming a customer" },
	{ id: "verify", title: "Verifying a proof yourself" },
	{ id: "endpoints", title: "Endpoint reference" },
];

const COOLDOWN_DAYS = Math.round(CONSENT_REASK_COOLDOWN_MS / (24 * 60 * 60 * 1000));

export default async function DocsPage() {
	// Same derivation as the install snippet itself. A vendor copying a command
	// off this page must reach the deployment they are reading it on, whether
	// that is production, a preview, or localhost.
	const origin = originFromHeaders(await headers()) ?? "https://app.letterprove.com";
	const tiers = tierLadderDocument();
	const [primaryHost, apexHost] = verificationHosts("example.com");

	return (
		<>
			<DevKeyBanner />
			<SiteHeader />

			<main className="mx-auto max-w-3xl px-6 py-14">
				<h1 className="text-4xl font-semibold tracking-tight text-balance">Documentation</h1>
				<p className="mt-6 leading-relaxed text-fog">
					Letterprove publishes signed, machine-readable evidence that the companies a vendor names
					really use their product, so an evaluating agent can check a logo wall instead of
					believing it. This page is the whole of it: how to install the script, what it sends, what
					the tiers mean, how a customer consents to being named, and how to verify any of it
					without trusting us.
				</p>
				<p className="mt-4 leading-relaxed text-fog">
					If you are here to check somebody else&apos;s claim rather than publish your own, skip to{" "}
					<a href="#verify" className="text-mint hover:underline">
						verifying a proof yourself
					</a>
					. That section is the point of the product.
				</p>

				<nav className="mt-10 rounded-lg border border-edge bg-panel p-5">
					<h2 className="text-xs font-semibold tracking-widest text-fog uppercase">On this page</h2>
					<ol className="mt-3 grid gap-1.5 text-sm">
						{SECTIONS.map((s, i) => (
							<li key={s.id}>
								<a href={`#${s.id}`} className="text-fog hover:text-mint">
									<span className="mr-2 text-fog/60 tabular-nums">{i + 1}.</span>
									{s.title}
								</a>
							</li>
						))}
					</ol>
				</nav>

				<div className="mt-12 space-y-12">
					<Section n={1} id="install" title="Install">
						<p>
							There is no Letterprove login. Letterstory is the identity authority for both
							products, so your account, your key, your customers and your consent links all live in
							the Proofs tab there, and everything below is reached from it. This site publishes the
							proof; it does not hold a session of yours.
						</p>
						<p>
							Installation is one script tag on the pages where people sign in. It has no
							dependencies, no build step, and nothing to configure beyond its <code>data-key</code>{" "}
							attribute.
						</p>
						<Snippet>{installSnippet(origin, "lp_live_yourslug_0123456789ab")}</Snippet>
						<p>
							<strong>Copy the snippet the Proofs tab gives you rather than this one.</strong> The
							real one is generated for you, with your own key, pointed at the origin that served
							it. That is not ceremony. A written-down host has broken collection twice: once when
							an install kept pointing at an old deployment URL after a domain move and stayed dead
							for 65 hours, and once when every vendor was handed a <code>cdn.letterprove.com</code>{" "}
							URL for a host that has never existed. The script is a static file served by this app
							at this app&apos;s origin and nowhere else.
						</p>
						<p>
							Both failures were silent, and that is the part worth understanding. The script is
							built so it can never break your page, which means a script that fails to load and a
							quiet weekend produce exactly the same thing: no events. Nobody gets an error. You get
							an empty dashboard and conclude the product does not work.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">
							The one hard rule: the domain only
						</h3>
						<p>
							You pass an email address to the script. The script splits the domain off in the
							browser and sends only the domain. <code>example.com</code>, never{" "}
							<code>someone@example.com</code>. The local part never enters a request body and never
							leaves the page.
						</p>
						<p>
							The domain does the entire job of attributing activity to a company. The local part
							adds nothing and carries everything: end-user personal data out of someone else&apos;s
							product, a data processing agreement with every vendor, and a breach story. The same
							discipline runs through the rest of the payload. No user ids, no cookies, no local
							storage, no IP address, no page URLs, no referrer.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">
							Nothing is counted until your domain is verified
						</h3>
						<p>
							Installing the script is not enough on its own. Until you have proven control of the
							domain by DNS, the collector accepts your requests and records nothing. Put a TXT
							record on either host:
						</p>
						<Snippet>
							{primaryHost}
							{"\n"}
							{apexHost}
						</Snippet>
						<Snippet>{`${TXT_PREFIX}=<the token shown in the Proofs tab>`}</Snippet>
						<p>
							<code>{primaryHost}</code> is the primary, following the same convention as{" "}
							<code>_dmarc</code> and <code>_acme-challenge</code>. The apex is accepted too,
							because that is where people expect a site-verification record to go.
						</p>
						<p>
							This gate is stricter than it needs to be for tier purposes alone, on purpose. If an
							unverified vendor could collect, whoever registered a domain first would accumulate
							events, rollups and history on it before the real owner ever arrived. Refusing at the
							door means an impersonator accumulates nothing and the legitimate owner verifies into
							a clean slate.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">Origin must match exactly</h3>
						<p>
							Every event is pinned to the browser&apos;s <code>Origin</code> header, which page
							script cannot override, and compared against the domain on your account. The
							comparison is exact on hostname. <code>www.example.com</code> and{" "}
							<code>example.com</code> are different origins, and the browser sends whichever one
							actually served the page, so the domain on your account has to be the host your users
							are really on. A mismatch here is the classic silent zero.
						</p>
						<p>
							Origin-pinning is a real constraint on a browser and no constraint at all on{" "}
							<code>curl</code>. That is a known, accepted limit rather than an oversight, and it is
							exactly why script-observed evidence sits low on the ladder below.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">Telling whether it works</h3>
						<p>
							Every collector response carries <Mono>x-letterprove: on</Mono> when the request was
							accepted and <Mono>off</Mono> when it was refused, so one <code>curl</code> answers
							the question instead of an afternoon. The body never says anything: the endpoint
							always answers <code>204</code>, including on a bad key, a malformed payload, an
							unverified domain or a rate limit, because a host page must never see a failure from
							us.
						</p>
						<p>
							The Proofs tab separates two questions that look identical from outside.{" "}
							<em>Installed</em> means the script has successfully fetched its config at least once,
							so it is really on the page. <em>Receiving</em> means an event has actually arrived.
							Installed but not receiving is normal on a marketing site with no sign-in, and is not
							a fault.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">About the key</h3>
						<p>
							The <code>data-key</code> value is publishable, not secret. It ships in your page HTML
							by design, which is why it cannot authenticate anything on its own and why origin and
							DNS verification carry that weight instead. Rotating the key takes effect immediately
							and the old one stops working at once, so every install has to be updated in the same
							change.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">
							Nothing is public until you publish it
						</h3>
						<p>
							Installing the script publishes nothing. Until you publish, every public URL about
							you — <code>/proofs/&lt;you&gt;</code>, <code>/attest/&lt;you&gt;</code> and both
							chain paths — answers <strong>404</strong>, the same 404 a vendor who does not exist
							gets, and you are absent from the discovery document. Nobody can tell from the
							outside that you are here.
						</p>
						<p>
							Everything else runs the whole time. Events are collected, rolled up hourly, signed,
							chained and frozen exactly as they would be if you were public. So publishing is a
							switch, not a build: the day you turn it on, your history already reaches back to
							your first observation instead of starting that morning. Install, watch it work for
							as long as you like, and go public when the numbers are worth showing.
						</p>
						<p>
							Publish and unpublish from the Proofs tab. Publishing needs your domain verified,
							because nothing is collected for an unverified domain and the only document we could
							sign for you would be a zero. Unpublishing takes every URL back to 404 — but it
							cannot un-fetch: an attestation someone already retrieved while you were public stays
							signed and stays verifiable, which is the whole point of signing it.
						</p>
					</Section>

					<Section n={2} id="client-api" title="The client API">
						<p>
							The script exposes exactly three calls on <code>window.Letterprove</code>. There is no
							fourth, and no general event method.
						</p>
						<Snippet>{`Letterprove.identify(email)  // establishes the domain, fires one "session" per page load
Letterprove.signup(email)    // identifies, then fires "signup"
Letterprove.login(email)     // identifies, then fires "login"`}</Snippet>
						<p>
							<code>identify</code> is what you call on an authenticated page load.{" "}
							<code>signup</code> and <code>login</code> call it internally before firing their own
							event, so an auth success handler never needs to call both. The <code>session</code>{" "}
							event fires at most once per page load no matter how many times you call{" "}
							<code>identify</code>.
						</p>
						<p>
							An address that cannot be split into a domain is dropped silently, and nothing is sent
							until one has been. There is no way to pass a domain directly: the split happens here
							so that the address cannot be sent by mistake.
						</p>
						<p>Three behaviours are worth knowing before you wire it up.</p>
						<ul>
							<li>
								<strong>It cannot throw into your page.</strong> Every public method is wrapped, and
								so is every transport path. Your product must behave identically whether this script
								loads, fails, or is missing.
							</li>
							<li>
								<strong>It fails closed.</strong> The script fetches its collection config once at
								boot. Calls made before that resolves are queued in memory and flushed when it does.
								If the fetch fails, the queue is dropped and the page collects nothing. It is never
								retried mid-page, because a guess is worse than a gap.
							</li>
							<li>
								<strong>
									Transport prefers <code>sendBeacon</code>
								</strong>
								, falling back to a <code>keepalive</code> fetch. Neither is awaited and neither
								surfaces a result.
							</li>
						</ul>
						<p>
							What actually goes over the wire is five fields: your publishable key, the domain, the
							event name, the config version that produced it, and a client timestamp. The timestamp
							is used for ordering and de-duplication only and is never authoritative. Counting
							happens on the server against our own receipt timestamp, because a counter the page
							can set is a counter the page can inflate. We additionally store the request origin
							and a country and region derived at the edge.
						</p>
						<p>
							Volume is capped at 300 requests a minute per source IP and 3,000 a minute per vendor
							key. Both refusals look like every other refusal: a <code>204</code> with{" "}
							<Mono>x-letterprove: off</Mono>.
						</p>
					</Section>

					<Section n={3} id="published" title="What a published attestation says">
						<p>
							Two kinds of document are published. The <strong>aggregate</strong> is a claim about a
							vendor and names nobody: how many distinct company domains were observed in the last
							30 days, and the session, signup and login totals behind that. The{" "}
							<strong>per-customer attestation</strong> names one company and reports what was
							observed for its domain. The aggregate is the only signed claim most vendors can
							publish, because naming a customer needs that customer&apos;s consent and counting
							them does not.
						</p>
						<p>
							The aggregate says <code>companies_observed</code>, and it means it. A session from an
							address at a company proves somebody there used the product. It does not prove that
							company buys it. Domains that can never name a company, free mail providers and the
							vendor&apos;s own, are counted separately as <code>domains_excluded</code> rather than
							silently dropped, so the headline can be read honestly.
						</p>
						<p>Inside a per-customer body, the fields have different provenance, and it matters:</p>
						<ul>
							<li>
								<code>sessions_30d</code> is measured. It is the sum of hourly rollups for that
								domain over the trailing 30 days.
							</li>
							<li>
								<code>seats_active</code> is <strong>always 0 today</strong>. Phase-one events carry
								no per-user dimension, so there is nothing honest to sum. It is signed as a literal
								zero because the field is covered by the signature, and it should be read as
								&ldquo;not yet measured&rdquo; rather than as a measurement of zero.
							</li>
							<li>
								<code>features</code> and <code>since</code> are vendor-asserted. Named feature
								events are a later phase and are not wired, so nothing observes feature use today.
							</li>
							<li>
								<code>contract_currency</code>, <code>contract_monthly</code> and{" "}
								<code>contract_since</code> appear only when an invoice in the vendor&apos;s Stripe
								account actually settled. They are absent rather than zero for everyone else,
								because a zero would assert &ldquo;pays nothing&rdquo; where absence correctly says
								&ldquo;we hold no payment evidence&rdquo;. <code>contract_since</code> is the first
								settled invoice, not the subscription&apos;s start date.
							</li>
							<li>
								<code>observed_through</code> is the end of the window summarised.{" "}
								<code>published_at</code> is when the snapshot was cut. They are deliberately
								separate.
							</li>
							<li>
								<code>method</code> is a commit-pinned link to the source file that computed the
								numbers. Nothing else in the document asks to be trusted.
							</li>
							<li>
								<code>prev_hash</code> is the SHA-256 of the previous signed snapshot for the same
								subject, with 64 zeroes at the start of a chain. This is what makes the history
								auditable rather than merely signed.
							</li>
						</ul>
						<p>
							Signing runs on a cadence, not per request. Rollups are written hourly on the hour,
							and the freeze that signs, chains and countersigns them runs five minutes later.
							Published documents carry a <code>ttl</code> of {TTL_SECONDS / 60} minutes, which
							matches that cadence.
						</p>
					</Section>

					<Section n={4} id="tiers" title="The tier ladder">
						<p>{tiers.note}</p>
						<div className="grid gap-2">
							{tiers.levels.map((level) => (
								<div key={level.tier} className="rounded border border-edge bg-ink/40 px-4 py-3">
									<div className="flex flex-wrap items-baseline gap-x-2">
										<span className="font-mono text-xs text-mint">tier {level.tier}</span>
										<span className="font-medium text-[#e9efed]">{level.name}</span>
									</div>
									<p className="mt-1 text-sm">{level.means}</p>
									<p className="mt-1.5 text-sm">
										<span className="text-fog/70">Forgeable by:</span> {level.forgeable_by}
									</p>
								</div>
							))}
						</div>
						<p>
							That list is rendered from the same definition the discovery document publishes, so
							this page cannot describe a ladder we do not serve.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">
							Your asserted tier is a ceiling, never a floor
						</h3>
						<p>
							A customer record carries a tier you set. Setting it to 2 does not make a claim tier
							2. It caps what the evidence is allowed to publish, and the evidence decides the rest.
							Concretely, and in this order:
						</p>
						<ul>
							<li>
								If the vendor&apos;s domain is not DNS-verified, the published tier is 0, whatever
								you asserted and whatever was observed. Without domain control, an observation is
								only the vendor asserting.
							</li>
							<li>
								If nothing at all was observed for that domain in the window, the published tier is
								0. A tier is a statement about evidence, and there is none.
							</li>
							<li>
								Otherwise the published tier is the one you asserted. Tiers 1 and 2 are therefore
								your own claim, released only once observation and domain control back it. The{" "}
								<code>verified</code> boolean comes from the same record and is released by the same
								two gates, so at those tiers it is your word, gated, rather than an independent
								finding.
							</li>
						</ul>
						<p>
							An unmeasurable window fails toward the weaker claim rather than the stronger one. A
							failed telemetry read, an unconfigured datastore and a genuinely empty window all
							leave the same mark: not observed, so tier 0.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">
							Two tiers are not capped by your assertion
						</h3>
						<p>
							<strong>Tier 4 short-circuits everything.</strong> If the customer has counter-signed,
							the claim is tier 4 before the domain and observation gates are even reached. That is
							the entire point of it: a counter-signature does not travel through the vendor&apos;s
							domain, script or pipeline, which is what makes it the one tier a vendor cannot forge.
							Capping it by a vendor-set number would be capping the one piece of evidence that did
							not come from the vendor.
						</p>
						<p>
							<strong>Tier 3 is not capped either</strong>, for the same reason: it is read from a
							third party&apos;s ledger rather than from anything you typed. A vendor understating
							their own tier should not suppress that. Tier 3 still sits below the observation and
							domain gates, because money proves a commercial relationship and not that the product
							was used.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">What tier 3 actually requires</h3>
						<p>
							It used to require an <code>active</code> subscription, which was not enough and was
							not honest. A subscription is what you configured, not what anyone paid: a $0
							recurring price reaches <code>active</code> the moment it is created, with no payment
							method attached and no money involved, and so does a 100%-off coupon. A signed
							tier-3 attestation naming any company you like cost nothing to manufacture in your own
							account. Every condition below is now checked instead:
						</p>
						<ul>
							<li>
								The key is <strong>live mode</strong>. A test-mode key reports real counts and
								stores nothing, because test payments are invented by definition.
							</li>
							<li>
								The subscription carries a <strong>real recurring price above zero</strong> on a
								real billing interval. The floor is simply &ldquo;above zero&rdquo;: any larger
								figure would be denominated in one currency&apos;s minor unit and would mean
								something different in yen, and it would exclude small customers who are real
								customers. The cost of forgery is the next bullet, not the size of the number.
							</li>
							<li>
								An <strong>invoice actually settled</strong> against it — paid, for a non-zero
								amount, with a charge or payment intent behind it. An invoice marked paid by hand
								(Stripe&apos;s <code>paid_out_of_band</code>) is you asserting payment, so it does
								not count, and it is reported back to you as such rather than dropped.
							</li>
							<li>
								That payment is <strong>recent</strong> relative to the billing interval: about a
								billing period plus a grace window for retries. A subscription that stays active
								for years while nothing is collected stops publishing as paid.
							</li>
							<li>
								<code>contract_since</code> is dated from the <strong>first settled invoice</strong>
								, never from the subscription&apos;s start date. A start date is a field you set,
								and Stripe accepts a backdated one, so tenure read from it was settable to any year
								you liked.
							</li>
						</ul>
						<p>
							Because of the invoice read, a restricted key now needs read access to{" "}
							<strong>Invoices</strong> as well as Subscriptions and Customers. A key without it
							fails the sync with that instruction rather than falling back to the weaker evidence:
							a corroboration check you can switch off by removing a permission is not a
							corroboration check.
						</p>
						<p>
							<strong>Evidence expires.</strong> The sync runs hourly, and payment evidence older
							than a day stops being published — not as a claim that the customer stopped paying,
							but as an honest refusal to keep asserting something nothing has confirmed since
							yesterday. Repeated sync failures clear the evidence outright. Both exist because
							disconnecting Stripe is something you control: without them, revoking your own key
							would freeze the last favourable answer in place for ever, with nothing left in the
							system that could ever contradict it.
						</p>
						<p>
							The honest limit: <strong>this raises the price of a forged tier 3 from nothing to a
							real charge through a real processor, in a live Stripe account Stripe has verified,
							leaving a record in your own books.</strong> It does not make it impossible. A vendor
							willing to pay themselves can still reach tier 3, and nothing here binds the Stripe
							account to the vendor in the first place — the key is pasted in, not granted through
							Connect. Read tier 3 as corroboration by a third party&apos;s ledger, not as immunity.
						</p>
						<p>
							One more caveat.{" "}
							<strong>Tier 3 has never run against a live-mode Stripe key in production.</strong> The
							publishing half is tested against the real schema with a live-mode flag, but a
							test-mode key deliberately stores nothing, so no production attestation has ever
							carried real payment evidence.
						</p>
						<p>
							The aggregate document uses a narrower rule of its own: tier 2 when anything at all
							was observed, tier 0 when nothing was.
						</p>
					</Section>

					<Section n={5} id="consent" title="Consent and naming a customer">
						<p>
							<strong>Anonymous is the default, and the default is applied on read.</strong> A
							customer record added without a consent decision is treated as anonymous, so a
							customer nobody thought about is withheld rather than published. Consent governs what
							leaves the building, not what we store: an unconsented customer still has snapshots
							computed and chained, and the per-customer endpoint simply refuses to serve them. That
							is what &ldquo;the moment consent lands, the history is already there&rdquo; has to
							mean to be more than a slogan.
						</p>
						<p>
							Naming a customer publishes a signed, immutable, public statement about a third party.
							Everything below follows from taking that seriously.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">
							Tier 4: the customer counter-signs
						</h3>
						<p>
							You generate a consent link from the Proofs tab and give us the address to send it to.
							That address <strong>must be on the customer&apos;s own domain</strong>, the exact
							domain or a subdomain of it. A sibling domain is refused: it looks equivalent to a
							human and is a completely different registration, which is precisely the substitution
							the check exists to catch. The domain is read from the customer record, never from the
							request, so a vendor cannot supply both sides of the comparison.
						</p>
						<p>
							<strong>You never receive the token.</strong> The link goes to the customer and the
							customer alone. Before that rule existed, a vendor could open the link themselves, and
							because a counter-signature outranks every other gate, that published the strongest
							tier in the system with nothing behind it.
						</p>
						<p>
							The link stays live for seven days. Generating a new one invalidates the previous one,
							which is how you replace a link that went to the wrong inbox or expired. The customer
							sees the exact usage summary that will be published, and approves or declines it.
						</p>
						<p>
							Approving sets consent to named and records the counter-signature together, in one
							act, because reviewing and approving your own attestation is both the strongest
							evidence in the system and the actual consent to be named. Nothing in the
							vendor-facing API can write those fields; only the customer&apos;s own response to
							that link can.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">Declining is remembered</h3>
						<p>
							A decline publishes nothing and kills the link. It is also recorded, with a count, and
							it blocks a re-ask for {COOLDOWN_DAYS} days. A customer here has no account, no
							dashboard and no other way to object, so a decline that could be ignored instantly was
							not really a decline. It is not permanent either: the record stays visible afterwards,
							it just stops blocking. The cooldown is checked before the recipient address is, so
							probing addresses during one tells you nothing.
						</p>
						<p>
							The decline is visible to you, which is the point. &ldquo;They said no&rdquo; and
							&ldquo;the email never arrived&rdquo; look identical otherwise.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">Withdrawal takes effect</h3>
						<p>
							Documents that name a third party are cached for 60 seconds and must be revalidated,
							with no stale-while-revalidate at all. Everything else here is cached for an hour with
							a day of stale-while-revalidate, which is right for a document that names nobody and
							badly wrong for one that does. Stale serving is the specific hazard: it authorises
							serving a document the origin has already stopped publishing. A withdrawn customer
							stayed publicly named from cache once, in production, after the change had landed.
						</p>
					</Section>

					<Section n={6} id="verify" title="Verifying a proof yourself">
						<p>
							Nothing on this site asks you to trust it. The verifier is a single standalone script
							with no dependencies, using only Node built-ins, short enough to read before you run
							it.
						</p>
						<p>
							It <strong>deliberately shares no code with this service</strong>. It re-implements
							canonicalisation and signature checking from the published description rather than
							importing ours, because a verifier built on the producer&apos;s own canonicaliser
							cannot detect the one bug that matters, which is the producer and the specification
							disagreeing. Agreement between two independent implementations is the only agreement
							worth anything here.
						</p>
						<p>Fetch what you want to check, and the keys it claims to be signed with:</p>
						<Snippet>{`curl -s ${origin}/attest/<vendor>/chain > chain.json
curl -s ${origin}/.well-known/letterprove-jwks.json > jwks.json`}</Snippet>
						<p>Then run the verifier over them, from a checkout of the repository:</p>
						<Snippet>{`git clone https://github.com/letterstory/Letterprove
cd Letterprove
npm run verify -- ./chain.json --jwks ./jwks.json`}</Snippet>
						<p>
							There is nothing to install first. The script imports only Node built-ins, so a clone
							is enough, and <code>node scripts/verify.mjs</code> works just as well as the npm
							script. It also takes URLs directly, in which case it fetches the JWKS from the same
							origin as the proof unless you pass <code>--jwks</code>:
						</p>
						<Snippet>{`npm run verify -- ${origin}/attest/<vendor>/chain`}</Snippet>
						<p>
							Point it at a <strong>chain</strong> rather than a single document. A lone attestation
							is a window into a history, and its <code>prev_hash</code> has nothing to be checked
							against; given the chain, the verifier checks every link.
						</p>
						<p>For each entry in the chain it does three things:</p>
						<ul>
							<li>
								Canonicalises every field except the signature. Object keys sorted, array order
								preserved, integers only. A non-integer number is a hard error rather than a
								rounding, because floats would break byte agreement between two implementations.
							</li>
							<li>
								Finds the published key whose id matches the document&apos;s <code>key_id</code> and
								checks the Ed25519 signature over those exact bytes. Retired keys are published
								forever, so an old proof still verifies years after its key leaves rotation.
							</li>
							<li>
								Recomputes the hash of the entry and checks the next entry&apos;s{" "}
								<code>prev_hash</code> against it, starting from 64 zeroes.
							</li>
						</ul>
						<p>
							It then prints the provenance tier from the head of the chain, the <code>method</code>{" "}
							link, and a warning if anything in the chain was signed with a development key. It
							exits non-zero if any entry failed.
						</p>

						<h3 className="pt-2 text-lg font-medium text-[#e9efed]">What agreement proves</h3>
						<p>
							A passing run proves two things and no more:{" "}
							<strong>this document is ours, and it has not been altered since we signed it</strong>
							, and the history behind it has not been quietly restated.
						</p>
						<p>
							It proves nothing whatsoever about how good the underlying evidence is.{" "}
							<strong>The tier says that, and the tier is the claim.</strong> A perfectly valid
							signature over a tier-0 body asserts only that the vendor said so. This is the more
							dangerous direction of failure: an agent that cannot read the tier does not distrust
							us, it over-trusts us, verifying a signature and reporting &ldquo;attested&rdquo;
							about a sentence the vendor typed. Read both, always.
						</p>
						<p>
							One more warning to take seriously. Anything signed by a development key is a
							demonstration and not evidence, because the development key is published and anyone
							can forge under it. Development deployments say so in a banner, in the discovery
							document, in the key id, and in the verifier&apos;s own output.
						</p>
						<p className="pt-1">
							<a href="/verify" className="text-mint hover:underline">
								The verify page
							</a>{" "}
							renders the live discovery document, and{" "}
							<a href="/keys" className="text-mint hover:underline">
								the keys page
							</a>{" "}
							renders the current JWKS, if you would rather read either in prose first.
						</p>
					</Section>

					<Section n={7} id="endpoints" title="Endpoint reference">
						<p>
							Every proof endpoint is public, unauthenticated and CORS-open, answers JSON as UTF-8,
							and carries <Mono>x-letterprove: on</Mono>. A proof nobody can fetch cross-origin is
							not proof.
						</p>
						<p>
							All of them resolve only once you have{" "}
							<a href="#install" className="text-mint hover:underline">
								published
							</a>
							. Before that they answer 404, indistinguishably from a vendor who does not exist.
						</p>
						<Endpoints origin={origin} />
						<p>
							<code>/proofs/&lt;vendor&gt;</code> is content-negotiated. A browser gets the human
							page; a <code>.json</code> suffix or an explicit JSON <code>Accept</code> with no HTML
							alternative gets the machine document, which carries the summary, each customer&apos;s
							current attestation, and the tier ladder inline so an agent that landed there directly
							can weight what it reads without a second fetch. <code>/attest/&lt;vendor&gt;</code>{" "}
							and the per-customer path both accept a <code>.json</code> suffix as well, for clients
							that cannot set a header.
						</p>
						<p>
							The two collection endpoints are called by the script, not by you. They live under{" "}
							<code>/api/v1/</code>, and both answer with the diagnostic header described in the
							install section.
						</p>
						<Snippet>{`GET  ${origin}/api/v1/config?k=<publishable key>
POST ${origin}/api/v1/observe`}</Snippet>
						<p>
							Start from{" "}
							<a href="/.well-known/letterprove.json" className="text-mint hover:underline">
								the discovery document
							</a>{" "}
							if you are writing an agent. It is built by the same function that renders the verify
							page, and it carries the signing algorithm and mode, the JWKS location, a
							commit-pinned link to the canonicalisation rules, a link to the verifier, the full
							tier ladder, and every published proof with its aggregate and chain URLs. One fetch
							gets you from &ldquo;this host publishes proof&rdquo; to a verified claim without
							reading any of this page.
						</p>
					</Section>
				</div>

				<div className="mt-16 border-t border-edge pt-8 text-sm text-fog">
					<p>
						Something here disagreeing with what the service actually does is a bug. The code is{" "}
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
			serves: "The aggregate attestation. Counts, no names",
		},
		{
			path: "/attest/<vendor>/chain",
			serves: "The full signed aggregate history, oldest first",
		},
		{
			path: "/attest/<vendor>/<customer>",
			serves: "One customer's current attestation, if they consented to be named",
		},
		{
			path: "/attest/<vendor>/<customer>/chain",
			serves: "That customer's full signed history",
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
							<td className="border-b border-edge/60 px-4 py-3 align-top text-fog">{row.serves}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className="px-4 py-3 text-xs text-fog">
				All relative to <span className="font-mono">{origin}</span>, the deployment serving this
				page.
			</p>
		</div>
	);
}
