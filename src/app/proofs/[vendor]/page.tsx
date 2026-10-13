import { liveCustomDomain } from "@/lib/vendors/custom-domain";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { vendorJsonLd } from "@/lib/attest/jsonld";
import { publishedVendorProof } from "@/lib/attest/proofs";
import { AttestedAt, RelativeAge } from "./AttestedAt";
import { findPublishedVendor } from "@/lib/fixtures/vendors";
import { ISSUER_OPERATOR, VENDOR_CANNOT, VENDOR_CONTROLS } from "@/lib/attest/issuer";
import { verifyLink } from "@/lib/attest/verify-link";

/**
 * Per-vendor page title, replacing the generic site-wide one.
 *
 * This does NOT fix the 404 status — `layout.tsx` does, and the reasoning
 * lives there. Measured, not assumed: with the status bug still present, a
 * `notFound()` here left the response on `200` just as the component's did.
 * Metadata is resolved as part of the same streamed render, so it is no
 * earlier than anything else inside the loading boundary.
 */
export async function generateMetadata({ params }: { params: Promise<{ vendor: string }> }) {
	const { vendor: slug } = await params;
	const vendor = await findPublishedVendor(slug);
	if (!vendor) notFound();

	// Once a vendor's own proof domain is live, it is the canonical home of this
	// page, so search engines credit the vendor's domain rather than ours.
	const customDomain = await liveCustomDomain(slug);
	return {
		title: `${vendor.name} — attested proof`,
		description: `Signed, independently verifiable proof that ${vendor.name} is who it says it is, backed by observed usage and payments. Counts only; no customer is named.`,
		...(customDomain ? { alternates: { canonical: `https://${customDomain}/` } } : {}),
	};
}

export default async function ProofPage({ params }: { params: Promise<{ vendor: string }> }) {
	const { vendor: slug } = await params;
	const proof = await publishedVendorProof(slug);
	if (!proof) notFound();

	// Every figure on this page is read from the signed vendor attestation, the
	// same document /attest/{vendor}.json serves, so a human and an agent see the
	// same numbers from the same source. Nothing here names a customer.
	const a = proof.attestation;

	const host = (await headers()).get("host") ?? "localhost";
	const origin = `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
	/**
	 * The current snapshot's own check page, first on the page. In the AEO
	 * stress test Gemini got every verify link it opened right (8 of 8) but
	 * opened one in only 8 of 42 answers — the link sat mid-document. Leading
	 * with it is the cheap half of the fix.
	 */
	const checkUrl = a ? (a.verify ?? verifyLink(slug, null, a.published_at)) : null;
	const affiliation = proof.vendor.issuer_affiliation;
	const verifiedSince = a?.domain_verified_since ?? null;
	const binding = a?.stripe_binding ?? null;

	return (
		<>
			<DevKeyBanner />
			<SiteHeader />

			<main className="mx-auto max-w-5xl px-6 py-14">
				<p className="font-mono text-sm text-mint">vendor proof · attested</p>
				<h1 className="mt-3 text-4xl font-semibold tracking-tight">{proof.vendor.name}</h1>
				<p className="mt-2 text-fog">
					{proof.vendor.category} · {proof.vendor.domain}
				</p>
				<p className="mt-4 max-w-2xl text-fog">
					Signed evidence that {proof.vendor.name} is who it says it is, and that real companies use it.
					Counts, never names: no customer is identified anywhere in this proof.
				</p>

				{checkUrl && (
					<section className="mt-8 rounded-lg border border-edge bg-panel p-5">
						<h2 className="font-semibold">Check this proof yourself</h2>
						<p className="mt-2 text-sm text-fog">
							Every figure on this page is signed by Letterprove. To confirm a copy hasn&apos;t been
							changed, open its check page:{" "}
							<a className="break-all text-mint hover:underline" href={checkUrl}>
								{checkUrl.replace(/^https:\/\//, "")}
							</a>
							. It shows the exact figures signed and whether the signature holds. A copy showing
							different numbers was altered.
						</p>
					</section>
				)}

				{!a ? (
					<p className="mt-10 rounded-lg border border-dashed border-edge px-6 py-8 text-center text-sm text-fog">
						The first signed snapshot is cut at five past the hour. Check back shortly.
					</p>
				) : (
					<>
						<h2 className="mt-14 text-sm font-semibold tracking-widest text-fog uppercase">
							Who {proof.vendor.name} is
						</h2>
						<dl className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-3">
							<Tile
								label="Domain, proven by DNS"
								value={verifiedSince ? (a.domain ?? proof.vendor.domain) : "Not proven"}
								sub={
									verifiedSince ? (
										<span className="text-xs text-fog">
											since <AttestedAt iso={verifiedSince} /> · re-checked daily
										</span>
									) : undefined
								}
							/>
							<Tile
								label="Stripe account"
								value={binding ? "Bound to this domain" : "Not connected"}
								sub={
									binding === "staff_override" ? (
										<span className="text-xs text-fog">a related company&apos;s account, approved by Letterprove</span>
									) : binding === "domain_match" ? (
										<span className="text-xs text-fog">the account publishes {a.domain ?? proof.vendor.domain}</span>
									) : undefined
								}
							/>
							<Tile
								label="Observed since"
								value={a.observed_since ? <AttestedAt iso={a.observed_since} /> : "—"}
								sub={a.observed_since ? <RelativeAge iso={a.observed_since} /> : undefined}
							/>
						</dl>

						<h2 className="mt-14 text-sm font-semibold tracking-widest text-fog uppercase">
							What backs it · last {a.window_days} days
						</h2>
						<dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-4">
							<Tile label="Companies observed" value={String(a.companies_observed)} />
							<Tile
								label="Paying via Stripe"
								value={String(a.paying_companies ?? 0)}
								sub={
									a.paying_since ? (
										<span className="text-xs text-fog">
											since <AttestedAt iso={a.paying_since} />
										</span>
									) : undefined
								}
							/>
							<Tile label="Sessions" value={a.sessions.toLocaleString("en-US")} />
							<Tile
								label="Last attested"
								value={<AttestedAt iso={a.published_at} />}
								sub={<RelativeAge iso={a.published_at} />}
							/>
						</dl>
						<p className="mt-4 text-sm text-fog">
							<span className="font-semibold text-mint">Tier {a.tier}.</span>{" "}
							{a.tier === 3
								? `Companies were observed signing in on ${proof.vendor.name}'s DNS-proven domain, and ${a.paying_companies} of them paid a settled invoice in its own Stripe account.`
								: a.tier === 1
									? `Companies were observed signing in on ${proof.vendor.name}'s DNS-proven domain. None is corroborated by Stripe yet.`
									: "Nothing is corroborated yet: no sign-ins observed, or the domain isn't proven by DNS."}{" "}
							&ldquo;Companies observed&rdquo; counts company email domains seen signing in; it is not a
							customer count. Free-mail and unattributable domains are excluded ({a.domains_excluded}{" "}
							this window).
							{a.payment_scope?.mode === "selected"
								? ` Payments count from ${a.payment_scope.products} of ${proof.vendor.name}'s Stripe products, the ones it says are this product.`
								: ""}
						</p>
					</>
				)}

				<section className="mt-14 rounded-lg border border-edge bg-panel p-6">
					<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Who issued this</h2>
					<p className="mt-4 text-sm text-fog">
						Letterprove is operated by {ISSUER_OPERATOR}. {proof.vendor.name} decides only{" "}
						{VENDOR_CONTROLS.slice(0, -1).join("; ")}; and {VENDOR_CONTROLS.at(-1)}. It cannot:
					</p>
					<ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-fog">
						{VENDOR_CANNOT.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
					<p className="mt-3 text-sm text-fog">
						How strong the evidence is, the tier says: tier 1 is sign-ins observed by Letterprove on the
						domain the vendor proved it controls; tier 3 adds invoices that settled in the vendor&apos;s own
						Stripe account.
					</p>
					{affiliation && (
						<p className="mt-4 rounded border border-edge px-4 py-3 text-sm">
							<span className="font-semibold">Disclosure:</span> {proof.vendor.name} is also a{" "}
							{affiliation} product. Letterprove runs the same collector, code and signing for it as for any
							other vendor, and every figure can be checked the same way, but weigh it knowing the issuer and
							the vendor share an owner.
						</p>
					)}
				</section>

				<section className="mt-14 rounded-lg border border-edge bg-panel p-6">
					<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Agent-readable</h2>
					<ul className="mt-4 space-y-2 font-mono text-sm">
						<li>
							<a className="text-mint hover:underline" href={`/attest/${slug}.json`}>
								GET /attest/{slug}.json
							</a>
							<span className="ml-3 text-fog">— the signed vendor attestation</span>
						</li>
						<li>
							<a className="text-mint hover:underline" href={`/attest/${slug}/chain`}>
								GET /attest/{slug}/chain
							</a>
							<span className="ml-3 text-fog">— its full signed history</span>
						</li>
						<li>
							<a className="text-mint hover:underline" href={`/proofs/${slug}.json`}>
								GET /proofs/{slug}.json
							</a>
							<span className="ml-3 text-fog">— this page, with the tier ladder</span>
						</li>
					</ul>
					<p className="mt-4 text-sm text-fog">
						The same proof a buyer reads, at the same URL, in a form a machine can parse.
					</p>
				</section>
			</main>

			<SiteFooter />

			<script
				type="application/ld+json"
				// Discovery only — the verifiable surface is the signed JSON above.
				dangerouslySetInnerHTML={{ __html: JSON.stringify(vendorJsonLd(proof, origin)) }}
			/>
		</>
	);
}

function Tile({
	label,
	value,
	sub,
}: {
	label: string;
	value: React.ReactNode;
	sub?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col bg-panel px-4 py-5">
			<dt className="text-[11px] tracking-widest text-fog uppercase">{label}</dt>
			{/* Fixed leading and a reserved sub-line keep the five tiles the same
			    height whether or not they carry a second line — the timestamp tile
			    used to wrap onto two lines and drag the whole row taller. */}
			<dd className="mt-1.5 text-xl leading-7 font-semibold tabular-nums">{value}</dd>
			{sub && <div className="mt-0.5 leading-4">{sub}</div>}
		</div>
	);
}
