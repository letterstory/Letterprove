import { redirect } from "next/navigation";
import { currentVendor } from "@/lib/vendors/session";
import { SignOutButton } from "./SignOutButton";
import { StatusIndicator } from "./StatusIndicator";

// Reads the signed-in user's session and vendor row per request; without
// this it gets prerendered once at build time with no user, same bug
// caught on the homepage (see src/app/page.tsx).
export const dynamic = "force-dynamic";

export default async function VendorHome() {
	const vendor = await currentVendor();
	// Defensive — the proxy's vendorAuthGate should already keep signed-out
	// users out of /vendor, but this page doesn't assume that held.
	if (!vendor) redirect("/vendor/login");

	const snippet = `<script src="https://cdn.letterprove.com/attest.js" data-key="${vendor.key}"></script>`;

	return (
		<main style={{ maxWidth: 480, margin: "4rem auto", padding: "0 1rem" }}>
			<h1>
				{vendor.name} <span style={{ color: "#666" }}>({vendor.category})</span>
			</h1>

			<section style={{ marginTop: "2rem" }}>
				<h2>Domain</h2>
				<p>{vendor.domain}</p>
				<p style={{ color: "#666" }}>
					Read-only — this is the origin collection pins every event against
					(see attest.js), so changing it isn&apos;t self-service yet.
				</p>
			</section>

			<section style={{ marginTop: "2rem" }}>
				<h2>Publishable key</h2>
				<pre style={{ background: "#f4f4f4", padding: "0.75rem", overflowX: "auto" }}>{vendor.key}</pre>
				<p style={{ color: "#666" }}>
					Not a secret — it ships in your page&apos;s HTML — but it&apos;s what identifies you to
					the collector, so don&apos;t hand it to another vendor.
				</p>
			</section>

			<section style={{ marginTop: "2rem" }}>
				<h2>Install snippet</h2>
				<pre style={{ background: "#f4f4f4", padding: "0.75rem", overflowX: "auto" }}>{snippet}</pre>
			</section>

			<section style={{ marginTop: "2rem" }}>
				<h2>Status</h2>
				<StatusIndicator />
			</section>

			<nav style={{ marginTop: "2rem", display: "flex", gap: "1rem" }}>
				<a href="/vendor/customers">Customers</a>
				<a href="/vendor/proof">Proof</a>
			</nav>

			<div style={{ marginTop: "2rem" }}>
				<SignOutButton />
			</div>
		</main>
	);
}
