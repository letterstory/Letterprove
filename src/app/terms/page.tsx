import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";

export const metadata: Metadata = {
	title: "Terms of Service — Letterprove",
	description:
		"The terms for using Letterprove, including what a signed attestation does and does not claim, and the obligations a vendor takes on by publishing one.",
};

const UPDATED = "September 24, 2026";

/**
 * The clauses that carry real weight here are §4 (what a signature actually
 * asserts) and §6 (consent before naming). Both encode product decisions
 * documented in the README — the provenance-tier model and the anonymous-by-
 * default consent gate — rather than boilerplate, because getting either wrong
 * is what would turn this product into the logo wall it exists to replace.
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
					Before we record anything for a domain, you must prove you control it by publishing a
					DNS record we specify. You may only verify domains you actually control, and attempting
					to claim someone else&apos;s domain is a breach of these terms.
				</p>
				<p>
					Until verification completes, events you send are discarded rather than stored. That is
					intended behaviour, not a fault.
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
					observed by our script, to bound to infrastructure facts you do not control, to
					corroborated by a third party, to counter-signed by the customer themselves. Anyone
					reading a proof is expected to weigh the tier rather than treat every claim as
					equivalent.
				</p>
				<p>
					One form of third-party corroboration: if you connect a Stripe account, we read your own
					records of a named customer&apos;s active, paid subscription to raise that customer above
					vendor-asserted. This evidence expires if it is not refreshed by a successful sync, so a
					stale Stripe connection reads as absent corroboration, not as proof the customer stopped
					paying.
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

			<Section n={6} title="Naming your customers">
				<p>
					Publishing that a named company uses your product discloses{" "}
					<strong>that company&apos;s</strong> information, not only yours.
				</p>
				<p>
					A customer is anonymous by default and is only named once you mark them as consenting.
					By doing so, <strong>you confirm that the customer has actually agreed</strong> to be
					identified publicly in this way. You are responsible for holding that consent, and for
					withdrawing it in Letterprove if the customer withdraws it with you.
				</p>
				<p>
					Anonymous customers still count toward your aggregate totals. Consent controls naming,
					not measurement.
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
					breach of these terms — including any claim by a customer you named without their
					consent.
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
