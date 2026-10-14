import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";

export const metadata: Metadata = {
	title: "Terms of Service — Letterprove",
	description:
		"The terms for using Letterprove, including what a signed attestation does and does not claim, and the obligations a vendor takes on by publishing one.",
};

const UPDATED = "October 13, 2026";

/**
 * The clauses that carry real weight here are §4 (what a signature actually
 * asserts) and §6 (customers are never named). Both encode product decisions
 * documented in the README — the provenance-tier model and the vendor-only
 * attestation (decision 30) — rather than boilerplate, because getting either
 * wrong is what would turn this product into the logo wall it exists to replace.
 */
export default function TermsPage() {
	return (
		<LegalPage
			title="Terms of Service"
			updated={UPDATED}
			intro="These terms govern your use of Letterprove, operated by The Letter Company. Letterprove publishes signed evidence about software usage, so several of these clauses are about what a published claim means — read §4 and §6 even if you skip the rest."
		>
			<Section n={1} title="Who these terms are for">
				<p>
					They apply to <strong>vendors</strong> — companies that create an account, install our
					script, and publish attestations. Visitors to a vendor&apos;s site are not party to
					these terms and take on no obligations under them.
				</p>
				<p>
					If you accept these terms for a company, you confirm you are authorised to bind that
					company.
				</p>
			</Section>

			<Section n={2} title="Your account">
				<p>
					Keep your credentials secure and tell us promptly if you believe they have been misused.
					You are responsible for activity under your account.
				</p>
				<p>
					Your publishable key is not a secret and is not a credential — it ships in your
					page&apos;s HTML by design. Access is controlled by domain verification, not by keeping
					that key private.
				</p>
			</Section>

			<Section n={3} title="Domain verification">
				<p>
					You prove you control your domain by publishing a DNS record we specify, or more weakly
					by carrying our script with your key on a page of that domain. Proof is optional: a
					proof without it is labelled &ldquo;Domain not verified&rdquo; and carries the lowest
					tier. You may only claim domains you actually control, and attempting to claim someone
					else&apos;s domain is a breach of these terms.
				</p>
			</Section>

			<Section n={4} title="What a Letterprove attestation claims">
				<p>
					This is the most important clause here, and it cuts against our own marketing interest,
					so we state it plainly.
				</p>
				<p>
					<strong>
						A Letterprove signature proves that we observed something. It does not, by itself,
						prove that the underlying claim is true.
					</strong>{" "}
					Our script runs on your site, so what it reports originates with the party who benefits
					from it looking good.
				</p>
				<p>
					Every published claim therefore carries a <strong>provenance tier</strong> describing how
					much independent corroboration stands behind it — from vendor-asserted at the bottom, to
					observed by our script on a domain you proved, to a third party confirming who you are. The tier is derived from that evidence alone; you cannot set it.
					Anyone reading a proof is expected to weigh the tier rather than treat every claim as
					equivalent.
				</p>
				<p>
					Third-party confirmation today means Stripe, used only to confirm who you are: if you
					connect your own live Stripe account, we read the account itself (whether Stripe has
					verified the business, its name, country and website) and nothing else. We read no
					payments and publish no revenue figure. The account must publish your domain, unless we
					approve a related company&apos;s account. The confirmation expires if it is not refreshed
					by a successful read.
				</p>
				<p>
					You agree not to represent a Letterprove attestation as certifying more than its tier
					supports.
				</p>
			</Section>

			<Section n={5} title="Acceptable use">
				<p>You must not:</p>
				<ul>
					<li>
						Send fabricated, simulated, or automated events, or otherwise inflate what the script
						reports. This is the one thing that would make the product worthless for everyone.
					</li>
					<li>Verify or attempt to verify a domain you do not control.</li>
					<li>
						Install the script anywhere other than a site you operate, or modify it to report
						something other than what it observes.
					</li>
					<li>
						Attempt to interfere with the service, evade rate limits, or access another
						vendor&apos;s data.
					</li>
				</ul>
				<p>
					We may suspend publication, suspend an account, or withdraw published attestations if we
					reasonably believe evidence has been fabricated.
				</p>
			</Section>

			<Section n={6} title="Your customers are never named">
				<p>
					A Letterprove attestation is about you: that you control your domain, the business
					Stripe has verified behind your Stripe account, and how many companies were observed
					using your product.{" "}
					<strong>It never contacts your customers, and names them only if you opt in to logo
					verification</strong>, which names companies already on your own public logo wall that we
					observed signing in. Otherwise only counts are published.
				</p>
				<p>
					Attestations that named individual customers were retired on October 13, 2026. Copies
					signed before then remain verifiable; their addresses no longer serve them.
				</p>
			</Section>

			<Section n={7} title="Your data and ours">
				<p>
					You keep ownership of the information you enter and the observations recorded for your
					domains. You grant us the licence needed to operate the service and to publish the
					attestations you choose to publish.
				</p>
				<p>
					Published attestations are signed and chained, which means a published entry cannot be
					silently altered or removed from history without breaking the chain that makes the whole
					record verifiable. You can stop publishing at any time; we cannot rewrite what was
					already published as though it never happened.
				</p>
			</Section>

			<Section n={8} title="Availability">
				<p>
					We aim to keep the service running but do not promise uninterrupted availability. We may
					change, suspend, or discontinue parts of it. Where a change would materially affect
					published proofs, we will make a reasonable effort to give notice.
				</p>
			</Section>

			<Section n={9} title="Disclaimer">
				<p>
					The service is provided &ldquo;as is&rdquo;, without warranties of any kind to the
					maximum extent permitted by law. We do not warrant that the service will be error-free,
					or that any measurement is complete or accurate for any particular purpose.
				</p>
			</Section>

			<Section n={10} title="Limitation of liability">
				<p>
					To the maximum extent permitted by law, The Letter Company is not liable for any
					indirect, incidental, special, consequential, or punitive damages, or for lost profits,
					lost revenue, lost data, or business interruption, arising from your use of Letterprove.
				</p>
				<p>
					This includes decisions made by you or by anyone else on the basis of a published
					attestation.
				</p>
				<p>
					Our total liability for any claim relating to the service is limited to the greater of
					the amount you paid us for it in the twelve months before the claim, or one hundred US
					dollars.
				</p>
				<p>
					Some jurisdictions do not allow certain limitations, in which case the above apply to
					the fullest extent permitted.
				</p>
			</Section>

			<Section n={11} title="Indemnification">
				<p>
					You agree to indemnify The Letter Company against claims, losses, and reasonable legal
					costs arising from your use of the service, from attestations you publish, or from your
					breach of these terms.
				</p>
			</Section>

			<Section n={12} title="Termination">
				<p>
					You may stop using Letterprove at any time. We may suspend or terminate access if you
					breach these terms, or if we reasonably believe your use puts the service or its
					credibility at risk. On termination your right to use the service ends immediately and
					your data is handled in accordance with our <a href="/privacy">Privacy Policy</a>.
				</p>
			</Section>

			<Section n={13} title="Changes to these terms">
				<p>
					We may update these terms as the service changes. We will update the date at the top,
					and for material changes we will make a reasonable effort to notify you. Continuing to
					use Letterprove after an update means you accept the revised terms.
				</p>
			</Section>

			<Section n={14} title="Contact">
				<p>
					Questions about these terms:{" "}
					<a href="mailto:support@letterbrace.com">support@letterbrace.com</a>
				</p>
			</Section>
		</LegalPage>
	);
}
