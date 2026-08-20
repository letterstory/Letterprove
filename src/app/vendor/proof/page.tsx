import { redirect } from "next/navigation";
import { currentVendor } from "@/lib/vendors/session";
import { vendorProof } from "@/lib/attest/proofs";
import { vendorAggregate } from "@/lib/attest/aggregate";

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
		<div className="max-w-2xl">
			<h1 className="text-2xl font-semibold tracking-tight">Your proof page</h1>

			{/* Shown FIRST and outside the !proof branch, because for most vendors
			    it is the only thing they publish. Naming a customer needs that
			    customer's consent, so a vendor with none still has a live, signed
			    claim here — and previously this page told them "No proof published
			    yet" while that claim was being served publicly. */}
			<h2 style={{ marginTop: "2rem" }}>Published now</h2>
			{!aggregate ? (
				<p>Nothing is being published — no usage has been observed yet.</p>
			) : aggregate.companies_observed === 0 ? (
				<p>
					No companies observed yet, so the attestation publishes a tier-0 claim. It fills in on
					its own once the script sees authenticated sessions.
				</p>
			) : (
				<>
					<p>
						<strong>{aggregate.companies_observed}</strong> companies observed,{" "}
						<strong>{aggregate.sessions}</strong> sessions over the last{" "}
						{aggregate.window_days} days — signed, tier {aggregate.tier}. This names nobody, so
						it needs no one&rsquo;s consent.
					</p>
					<ul>
						<li>
							<a href={`/attest/${vendor.slug}.json`}>/attest/{vendor.slug}.json</a> — the signed
							attestation
						</li>
						<li>
							<a href={`/attest/${vendor.slug}/chain`}>/attest/{vendor.slug}/chain</a> — its full
							history, each entry chained to the one before it
						</li>
					</ul>
				</>
			)}

			{!proof ? (
				<p>No proof published yet.</p>
			) : (
				<>
					<p>
						This is exactly what&rsquo;s already public at{" "}
						<a href={`/proofs/${vendor.slug}`}>/proofs/{vendor.slug}</a>. Nothing on this page is
						held back or pending approval — the only things not shown by name are customers who
						haven&rsquo;t consented to be named, and even those are counted in the totals below.
					</p>

					<h2 style={{ marginTop: "2rem" }}>Summary</h2>
					<ul>
						<li>Attested customers: {proof.summary.attested_customers}</li>
						<li>Attested, unnamed: {proof.summary.attested_unnamed}</li>
						<li>Features proven: {proof.summary.features_proven.join(", ") || "none"}</li>
						<li>Sessions / 30d: {proof.summary.sessions_30d.toLocaleString("en-US")}</li>
						<li>Last attested: {proof.summary.last_attested || "never"}</li>
					</ul>

					<h2 style={{ marginTop: "2rem" }}>Named customers</h2>
					{proof.customers.length === 0 ? (
						<p>No named customers yet.</p>
					) : (
						<ul>
							{proof.customers.map((c) => (
								<li key={c.current.customer} style={{ marginBottom: "1rem" }}>
									<strong>{c.current.customer_name}</strong> —{" "}
									{c.current.verified
										? `verified · tier ${c.current.tier}`
										: c.current.tier === 0
											? "vendor-asserted · tier 0"
											: `observed · tier ${c.current.tier}`}
									<br />
									Active since {c.current.since} · sessions/30d {c.current.sessions_30d} · seats
									active {c.current.seats_active}
									<br />
									Features: {c.current.features.join(", ") || "none"}
									<br />
									<a href={`/attest/${vendor.slug}/${c.current.customer}.json`}>
										{c.current.key_id} · {c.current.signature.slice(0, 16)}…
									</a>
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</div>
	);
}
