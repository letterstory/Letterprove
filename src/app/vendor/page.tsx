import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentVendor } from "@/lib/vendors/session";
import { installSnippet, originFromHeaders } from "@/lib/vendors/install";
import { StatusIndicator } from "./StatusIndicator";
import { DomainCard } from "./DomainCard";
import { StripeCard } from "./StripeCard";
import { connectionFor } from "@/lib/stripe/credentials";
import { dbClient } from "@/lib/db/client";
import { expectedRecord, verificationHosts } from "@/lib/vendors/verification";

// Reads the signed-in user's session and vendor row per request; without
// this it gets prerendered once at build time with no user, same bug
// caught on the homepage (see src/app/page.tsx).
export const dynamic = "force-dynamic";

export default async function VendorHome() {
	const vendor = await currentVendor();
	// Defensive — the proxy's vendorAuthGate should already keep signed-out
	// users out of /vendor, but this page doesn't assume that held.
	if (!vendor) redirect("/vendor/login");

	// Built from the origin serving this page, never a written-down host: this
	// snippet used to point at cdn.letterprove.com, which has never existed.
	// See lib/vendors/install.ts.
	const origin = originFromHeaders(await headers()) ?? "https://app.letterprove.com";
	const snippet = installSnippet(origin, vendor.key);

	// The verification token and timestamp aren't on CurrentVendor — they are
	// dashboard-only, and currentVendor() is the shape every other caller
	// shares. Read through the service-role client for the same reason the
	// verify route does: `vendors` has no UPDATE/extra-column policy.
	const db = dbClient();
	const { data: verification } = db
		? await db
				.from("vendors")
				.select("domain_verification_token, domain_verified_at")
				.eq("id", vendor.id)
				.maybeSingle()
		: { data: null };

	// Safe subset only — connectionFor() selects the last four, the mode and
	// sync state, never the ciphertext.
	const stripeConnection = await connectionFor(vendor.id);

	return (
		<>
			<div className="flex flex-wrap items-baseline justify-between gap-3">
				<h1 className="text-2xl font-semibold tracking-tight">
					{vendor.name} <span className="ml-1 text-base font-normal text-fog">{vendor.category}</span>
				</h1>
				<StatusIndicator />
			</div>

			<div className="mt-8 grid gap-4">
				<DomainCard
					domain={vendor.domain}
					record={
						verification?.domain_verification_token
							? expectedRecord(verification.domain_verification_token)
							: null
					}
					hosts={verificationHosts(vendor.domain)}
					verifiedAt={verification?.domain_verified_at ?? null}
				/>

				<StripeCard connection={stripeConnection} />

				<section className="rounded-lg border border-edge bg-panel p-5">
					<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Publishable key</h2>
					<pre className="mt-3 overflow-x-auto rounded border border-edge bg-ink p-3 font-mono text-sm text-mint">
						{vendor.key}
					</pre>
					<p className="mt-2 text-sm text-fog">
						Not a secret — it ships in your page&apos;s HTML — but it&apos;s what identifies you
						to the collector, so don&apos;t hand it to another vendor.
					</p>
				</section>

				<section className="rounded-lg border border-edge bg-panel p-5">
					<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Install snippet</h2>
					<pre className="mt-3 overflow-x-auto rounded border border-edge bg-ink p-3 font-mono text-sm text-mint">
						{snippet}
					</pre>
				</section>
			</div>
		</>
	);
}
