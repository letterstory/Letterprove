import { liveCustomDomain } from "@/lib/vendors/custom-domain";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { vendorJsonLd } from "@/lib/attest/jsonld";
import { publishedVendorProof } from "@/lib/attest/proofs";
import { AttestedAt, RelativeAge } from "./AttestedAt";
import { findPublishedVendor } from "@/lib/fixtures/vendors";
import { ISSUER_OPERATOR } from "@/lib/attest/issuer";
import { verifyLink } from "@/lib/attest/verify-link";
import { leadSentence, METHODOLOGY_URL } from "@/lib/attest/lead";

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/** How each hideable section reads in the "Hidden by" note. */
const HIDDEN_LABELS: Record<string, string> = {
	sessions: "session counts",
	reported_history: "PostHog history",
	logos: "logo verification",
	payment_details: "payment details",
	observed_since: "first observed date",
	hosts: "extra hosts",
};


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
		title: `${vendor.name} · Letterprove`,
		description: leadSentence(Boolean(vendor.issuerAffiliation)),
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
	const hidden = new Set<string>(a?.hidden_by_vendor ?? []);

	return (
		<>
			<DevKeyBanner />
			<SiteHeader />

			<main className="mx-auto max-w-5xl px-6 py-14">
				<p className="font-mono text-sm text-mint">Letterprove</p>
				<h1 className="mt-3 text-4xl font-semibold tracking-tight">{proof.vendor.name}</h1>
				<p className="mt-2 text-fog">{a?.domain ?? proof.vendor.domain}</p>
				<p className="mt-4 max-w-2xl text-fog">
					{leadSentence(Boolean(proof.vendor.issuer_affiliation))}{" "}
					<a className="text-mint hover:underline" href={a?.method ?? METHODOLOGY_URL}>
						Open-source methodology
					</a>
					.
				</p>

				{checkUrl && (
					<p className="mt-6 text-sm text-fog">
						Verify:{" "}
						<a className="break-all text-mint hover:underline" href={checkUrl}>
							{checkUrl.replace(/^https:\/\//, "")}
						</a>
					</p>
				)}

				{!a ? (
					<p className="mt-10 rounded-lg border border-dashed border-edge px-6 py-8 text-center text-sm text-fog">
						No signed snapshot yet. The next one is cut at five past the hour.
					</p>
				) : (
					<>
						{a.logos && (
							<>
								<h2 className="mt-10 text-sm font-semibold tracking-widest text-fog uppercase">
									Logos on {hostOf(a.logos.page)}
								</h2>
								<p className="mt-4 text-sm text-fog">
									<span className="font-semibold text-mint">
										{a.logos.verified} of {a.logos.on_page} logos verified:{" "}
										{a.logos.companies.filter((c) => c.status === "paying").length} paying (verified by Stripe),{" "}
										{a.logos.companies.filter((c) => c.status === "active").length} signed in in the last 30 days.
									</span>{" "}
									Checked against{" "}
									<a className="break-all text-mint hover:underline" href={a.logos.page}>
										{a.logos.page.replace(/^https:\/\//, "")}
									</a>
									. Verified means Letterprove observed the company signing in, or Stripe verified it pays.
								</p>
								{a.logos.companies.length > 0 && (
									<ul className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-2">
										{a.logos.companies.map((c) => (
											<li key={c.domain} className="flex items-baseline justify-between gap-3 bg-panel px-4 py-3">
												<span className="font-medium">{c.name}</span>
												<span className="text-xs text-fog">
													{c.status === "paying" ? "Paying, verified by Stripe" : "Signed in, last 30 days"}
												</span>
											</li>
										))}
									</ul>
								)}
							</>
						)}

						<h2 className="mt-12 text-sm font-semibold tracking-widest text-fog uppercase">Identity</h2>
						<dl
							className={`mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-edge bg-edge ${hidden.has("observed_since") ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}
						>
							<Tile
								label="Domain"
								value={verifiedSince ? "Verified by DNS" : "Not verified"}
								sub={
									verifiedSince ? (
										<span className="text-xs text-fog">
											since <AttestedAt iso={verifiedSince} />, checked daily
										</span>
									) : undefined
								}
							/>
							<Tile
								label="Stripe account"
								value={binding ? "Bound to domain" : "Not connected"}
								sub={
									binding === "staff_override" ? (
										<span className="text-xs text-fog">related company, approved by Letterprove</span>
									) : undefined
								}
							/>
							{!hidden.has("observed_since") && (
								<Tile
									label="First observed"
									value={a.observed_since ? <AttestedAt iso={a.observed_since} /> : "—"}
								/>
							)}
						</dl>

						<h2 className="mt-12 text-sm font-semibold tracking-widest text-fog uppercase">
							Last {a.window_days} days
						</h2>
						<dl
							className={`mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-edge bg-edge ${a.sessions === undefined ? "sm:grid-cols-3" : "sm:grid-cols-4"}`}
						>
							<Tile label="Companies" value={a.companies_observed.toLocaleString("en-US")} />
							<Tile
								label="Payments"
								value={a.tier === 3 ? "Verified by Stripe" : binding ? "Not verified" : "Not connected"}
								sub={
									a.paying_since ? (
										<span className="text-xs text-fog">
											first verified payment <AttestedAt iso={a.paying_since} />
										</span>
									) : undefined
								}
							/>
							{a.sessions !== undefined && <Tile label="Sessions" value={a.sessions.toLocaleString("en-US")} />}
							<Tile
								label="Signed"
								value={<AttestedAt iso={a.published_at} />}
								sub={<RelativeAge iso={a.published_at} />}
							/>
						</dl>
						<dl className="mt-4 grid gap-1 text-sm text-fog">
							<div>
								<dt className="inline font-semibold text-mint">Tier {a.tier}. </dt>
								<dd className="inline">
									{a.tier === 3
										? "Sign-ins observed on the verified domain. Payments verified in the bound Stripe account."
										: a.tier === 1
											? "Sign-ins observed on the verified domain."
											: "No sign-ins observed on a verified domain."}
								</dd>
							</div>
							<div>
								<dt className="inline">Companies: </dt>
								<dd className="inline">
									distinct company email domains that signed in. {a.domains_excluded} free-mail or
									unattributable domains excluded.
								</dd>
							</div>
							{a.payment_scope?.mode === "selected" && (
								<div>
									<dt className="inline">Payments: </dt>
									<dd className="inline">{a.payment_scope.products} Stripe products in scope.</dd>
								</div>
							)}
						</dl>

						{a.reported_history && (
							<>
								<h2 className="mt-12 text-sm font-semibold tracking-widest text-fog uppercase">
									Reported by {proof.vendor.name} · PostHog
								</h2>
								<dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-3">
									<Tile
										label="Companies"
										value={a.reported_history.companies.toLocaleString("en-US")}
										sub={
											a.reported_history.since ? (
												<span className="text-xs text-fog">
													since <AttestedAt iso={a.reported_history.since} />
												</span>
											) : undefined
										}
									/>
									<Tile
										label="Active, last 30 days"
										value={a.reported_history.active_companies_30d.toLocaleString("en-US")}
									/>
									<Tile
										label="Also observed by Letterprove"
										value={`${a.reported_history.observed_also_reported} of ${a.companies_observed}`}
									/>
								</dl>
								<p className="mt-4 text-sm text-fog">
									Read from {proof.vendor.name}&apos;s PostHog project. Reported by the vendor; not used for
									the tier.
								</p>
							</>
						)}
					</>
				)}

				{a && hidden.size > 0 && (
					<p className="mt-10 text-sm text-fog">
						Hidden by {proof.vendor.name}: {[...hidden].map((h) => HIDDEN_LABELS[h] ?? h).join(", ")}.
					</p>
				)}

				<section className="mt-12 rounded-lg border border-edge bg-panel p-6">
					<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Issuer</h2>
					<p className="mt-4 text-sm text-fog">
						Letterprove, operated by {ISSUER_OPERATOR}. {proof.vendor.name} cannot edit any figure, hold the
						signing key, rewrite past snapshots, or name a customer.
					</p>
					{affiliation && (
						<p className="mt-3 text-sm text-fog">
							<span className="font-semibold">Disclosure:</span> {proof.vendor.name} and Letterprove are both
							operated by {affiliation}. The same collector, code and signing apply.
						</p>
					)}
				</section>

				<footer className="mt-12 text-sm text-fog">
					For agents:{" "}
					<a className="font-mono text-mint hover:underline" href={`/attest/${slug}.json`}>
						/attest/{slug}.json
					</a>{" "}
					(signed),{" "}
					<a className="font-mono text-mint hover:underline" href={`/attest/${slug}/chain`}>
						/attest/{slug}/chain
					</a>{" "}
					(history)
				</footer>
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
