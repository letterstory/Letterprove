import { redirect } from "next/navigation";
import { currentVendor } from "@/lib/vendors/session";
import { vendorProof } from "@/lib/attest/proofs";

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

	const proof = await vendorProof(vendor.slug);

	return (
		<main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
			<a href="/vendor">&larr; Dashboard</a>
			<h1>Your proof page</h1>

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
		</main>
	);
}
