import { headers } from "next/headers";
import Link from "next/link";
import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { allVendors } from "@/lib/fixtures/vendors";
import { originFromHeaders } from "@/lib/vendors/install";

// This list is now DB-backed, not a hardcoded fixture — a vendor who signs
// up should appear here without waiting for the next deploy, so this can't
// be statically prerendered at build time.
export const dynamic = "force-dynamic";

export default async function Home() {
	const vendors = await allVendors();

	// The command a visitor copies must point at the deployment they are reading
	// it on. This said `http://localhost:9100/attest/vantage/acme-corp.json` in
	// production for as long as the page has existed — "verify it yourself" is
	// the entire pitch of this product, and following it got connection refused.
	//
	// The target is a CHAIN, and a real vendor's rather than the acme-corp
	// fixture: the fixture is a company that does not exist, publishing tier 0
	// because the evidence gate correctly refuses to promote it, so it was also
	// the least convincing thing we could have offered. Falls back to the first
	// vendor, and to the canonical host when no Host header is available.
	const origin = originFromHeaders(await headers()) ?? "https://app.letterprove.com";
	const demo = vendors.find((v) => v.slug === "lettertrace") ?? vendors[0];
	const verifyTarget = demo ? `${origin}/attest/${demo.slug}/chain` : `${origin}/.well-known/letterprove.json`;

	return (
		<>
			<DevKeyBanner />
			<SiteHeader />

			<main className="mx-auto max-w-5xl px-6 py-16">
				<h1 className="max-w-2xl text-4xl leading-tight font-semibold tracking-tight">
					Attested proof, in a form an agent can <span className="text-mint">verify</span>.
				</h1>
				<p className="mt-5 max-w-2xl text-lg text-fog">
					A logo wall can be faked. Every attestation published here is signed, chained to the one
					before it, and carries a commit-pinned link to the code that computed it.
				</p>

				<h2 className="mt-16 text-sm font-semibold tracking-widest text-fog uppercase">
					Published proofs
				</h2>
				<ul className="mt-4 divide-y divide-edge border-y border-edge">
					{vendors.map((v) => (
						<li key={v.slug}>
							<Link
								href={`/proofs/${v.slug}`}
								className="group flex items-baseline justify-between gap-4 py-4"
							>
								<span>
									<span className="text-lg font-medium group-hover:text-mint">{v.name}</span>
									<span className="ml-3 text-sm text-fog">{v.category}</span>
								</span>
								<span className="font-mono text-sm text-fog">/proofs/{v.slug} →</span>
							</Link>
						</li>
					))}
				</ul>

				<section className="mt-16 rounded-lg border border-edge bg-panel p-6">
					<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">
						Verify it yourself
					</h2>
					<p className="mt-3 text-fog">
						The verifier is a standalone script with no dependencies — it re-implements
						canonicalisation rather than importing ours, so agreeing is meaningful.
					</p>
					<pre className="mt-4 overflow-x-auto rounded border border-edge bg-ink p-4 font-mono text-sm text-mint">
						npm run verify -- {verifyTarget}
					</pre>
					<p className="mt-3 text-sm text-fog">
						That is the full signed history, not a single document: the verifier checks every
						signature and every <span className="font-mono">prev_hash</span> link, and prints
						the provenance tier the evidence earned.
					</p>
				</section>
			</main>

			<SiteFooter />
		</>
	);
}
