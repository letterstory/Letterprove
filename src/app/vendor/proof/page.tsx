import { redirect } from "next/navigation";
import { currentVendor } from "@/lib/vendors/session";
import { vendorProof } from "@/lib/attest/proofs";
import { vendorAggregate } from "@/lib/attest/aggregate";
import { Badge, Card, EmptyState, Mono, PageHeader, Stat, StatRow } from "@/components/ui";

// Reads the signed-in vendor's session and live proof data per request;
// without this it gets prerendered once at build time with no vendor, same
// bug caught on the homepage (see src/app/page.tsx).
export const dynamic = "force-dynamic";

// This page is a preview of the vendor's own public proof page, not a
// staging area. There is no review/approval step in this codebase between
// a customer's attestation and it being published at /proofs/{slug} — the
// note below says that plainly rather than implying a gate that doesn't
// exist. The two exceptions, both from proofs.ts itself, are: (1) unnamed
// customers are only ever shown here in aggregate (attested_unnamed), same
// as on the public page, and (2) unattested (tier 0) customers don't
// appear in vendorProof()'s named list at all.
export default async function VendorProofPage() {
	const vendor = await currentVendor();
	if (!vendor) redirect("/vendor/login");

	const [proof, aggregate] = await Promise.all([
		vendorProof(vendor.slug),
		vendorAggregate(vendor.slug),
	]);

	return (
		<>
			<PageHeader
				title="Your proof page"
				aside={
					<a
						href={`/proofs/${vendor.slug}`}
						className="rounded border border-edge px-3 py-1.5 text-sm text-fog transition hover:border-mint hover:text-mint"
					>
						View public page ↗
					</a>
				}
			>
				Everything here is already live at{" "}
				<a href={`/proofs/${vendor.slug}`} className="text-mint hover:underline">
					/proofs/{vendor.slug}
				</a>
				. Nothing is held back or pending approval — the only customers not shown by name are those
				who haven&rsquo;t consented to be, and they still count in the totals.
			</PageHeader>

			{/* The aggregate comes first, outside the !proof branch, because for
			    most vendors it is the only thing they publish. Naming a customer
			    needs that customer's consent, so a vendor with none still has a
			    live signed claim — this page once said "No proof published yet"
			    while that claim was being served publicly. */}
			<div className="mt-8">
				<StatRow>
					<Stat
						label="Companies observed"
						value={aggregate ? aggregate.companies_observed.toLocaleString("en-US") : "—"}
						tone={aggregate?.companies_observed ? "mint" : "muted"}
						hint="in the aggregate claim"
					/>
					<Stat
						label={`Sessions / ${aggregate?.window_days ?? 30}d`}
						value={aggregate ? aggregate.sessions.toLocaleString("en-US") : "—"}
					/>
					<Stat
						label="Named customers"
						value={proof ? proof.summary.attested_customers : 0}
						hint={proof ? `${proof.summary.attested_unnamed} attested but unnamed` : undefined}
					/>
					<Stat
						label="Last attested"
						value={<span className="text-base font-medium">{lastAttested(proof?.summary.last_attested)}</span>}
						hint={proof?.summary.last_attested ? "attestations refresh hourly" : undefined}
					/>
				</StatRow>
			</div>

			<div className="mt-4 grid gap-4">
				<Card
					title="Published now"
					aside={
						aggregate ? (
							<Badge tone={aggregate.companies_observed ? "mint" : "neutral"}>
								signed · tier {aggregate.tier}
							</Badge>
						) : null
					}
				>
					{!aggregate ? (
						<p className="text-sm text-fog">
							Nothing is being published — no usage has been observed yet.
						</p>
					) : (
						<>
							<p className="text-sm leading-relaxed text-fog">
								{aggregate.companies_observed === 0 ? (
									<>
										No companies observed yet, so the attestation publishes a tier-0 claim. It
										fills in on its own once the script sees authenticated sessions.
									</>
								) : (
									<>
										<strong className="text-[#e9efed]">{aggregate.companies_observed}</strong>{" "}
										companies observed and{" "}
										<strong className="text-[#e9efed]">
											{aggregate.sessions.toLocaleString("en-US")}
										</strong>{" "}
										sessions over the last {aggregate.window_days} days. This names nobody, so it
										needs no one&rsquo;s consent.
									</>
								)}
							</p>

							<div className="mt-4 grid gap-2">
								<ProofLink
									href={`/attest/${vendor.slug}.json`}
									label={`/attest/${vendor.slug}.json`}
									description="the signed attestation"
								/>
								<ProofLink
									href={`/attest/${vendor.slug}/chain`}
									label={`/attest/${vendor.slug}/chain`}
									description="its full history, each entry chained to the one before it"
								/>
							</div>
						</>
					)}
				</Card>

				<Card title="Named customers">
					{!proof || proof.customers.length === 0 ? (
						<EmptyState title="No named customers yet">
							A customer is only named once they&rsquo;ve consented. Until then they still count
							toward the totals above — switch one to &ldquo;named&rdquo; on the Customers tab
							when they agree.
						</EmptyState>
					) : (
						<ul className="grid gap-3">
							{proof.customers.map((c) => (
								<li
									key={c.current.customer}
									className="rounded-lg border border-edge bg-ink/40 p-4 transition-colors hover:border-mint/30"
								>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<span className="font-medium text-[#e9efed]">{c.current.customer_name}</span>
										<Badge tone={c.current.verified ? "mint" : "neutral"}>
											{c.current.verified
												? `verified · tier ${c.current.tier}`
												: c.current.tier === 0
													? "vendor-asserted · tier 0"
													: `observed · tier ${c.current.tier}`}
										</Badge>
									</div>

									<dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
										<Pair label="Since" value={c.current.since} />
										<Pair label="Sessions / 30d" value={c.current.sessions_30d.toLocaleString("en-US")} />
										<Pair label="Seats active" value={c.current.seats_active} />
										<Pair label="Features" value={c.current.features.join(", ") || "none"} />
									</dl>

									<a
										href={`/attest/${vendor.slug}/${c.current.customer}.json`}
										className="mt-3 inline-block font-mono text-xs text-fog transition hover:text-mint"
									>
										{c.current.key_id} · {c.current.signature.slice(0, 16)}…
									</a>
								</li>
							))}
						</ul>
					)}
				</Card>
			</div>
		</>
	);
}

function ProofLink({ href, label, description }: { href: string; label: string; description: string }) {
	return (
		<a
			href={href}
			className="group flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded border border-edge bg-ink/40 px-3 py-2 transition hover:border-mint/40"
		>
			<Mono>
				<span className="text-mint group-hover:underline">{label}</span>
			</Mono>
			<span className="text-xs text-fog">{description}</span>
		</a>
	);
}

/**
 * The raw value is an ISO timestamp, which wrapped across two lines in the
 * stat tile and read as machine output rather than an answer. Time of day
 * matters here — attestations refresh hourly — so keep it, just legibly.
 */
function lastAttested(iso: string | undefined): string {
	if (!iso) return "never";
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	return at.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function Pair({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div>
			<dt className="text-[11px] tracking-wide text-fog uppercase">{label}</dt>
			<dd className="mt-0.5 text-[#e9efed]">{value}</dd>
		</div>
	);
}
