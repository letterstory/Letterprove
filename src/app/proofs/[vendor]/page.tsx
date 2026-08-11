import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { vendorJsonLd } from "@/lib/attest/jsonld";
import { vendorProof, type CustomerProof } from "@/lib/attest/proofs";
import { FEATURES } from "@/lib/fixtures/vendors";

export default async function ProofPage({ params }: { params: Promise<{ vendor: string }> }) {
	const { vendor: slug } = await params;
	const proof = await vendorProof(slug);
	if (!proof) notFound();

	const host = (await headers()).get("host") ?? "localhost";
	const origin = `${host.startsWith("localhost") ? "http" : "https"}://${host}`;

	return (
		<>
			<DevKeyBanner />
			<SiteHeader />

			<main className="mx-auto max-w-5xl px-6 py-14">
				<p className="font-mono text-sm text-mint">customer success report · attested</p>
				<h1 className="mt-3 text-4xl font-semibold tracking-tight">{proof.vendor.name}</h1>
				<p className="mt-2 text-fog">
					{proof.vendor.category} · {proof.vendor.domain}
				</p>

				<dl className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-4">
					<Tile label="Attested customers" value={String(proof.summary.attested_customers)} />
					<Tile label="Features proven" value={String(proof.summary.features_proven.length)} />
					<Tile label="Sessions / 30d" value={proof.summary.sessions_30d.toLocaleString("en-US")} />
					<Tile label="Last attested" value={shortStamp(proof.summary.last_attested)} />
				</dl>

				{/* NOT "verified customers" — this list includes tier-1 observations,
				    which are published and labelled as such. A heading that rounds
				    them up to verified is the same lie the product exists to replace. */}
				<h2 className="mt-14 text-sm font-semibold tracking-widest text-fog uppercase">
					Attested customers
				</h2>
				<div className="mt-4 grid gap-4 sm:grid-cols-2">
					{proof.customers.map((c) => (
						<CustomerCard key={c.current.customer} proof={c} vendor={slug} />
					))}
				</div>

				<h2 className="mt-14 text-sm font-semibold tracking-widest text-fog uppercase">
					Feature-level proof
				</h2>
				<div className="mt-4 overflow-x-auto rounded-lg border border-edge">
					<table className="w-full text-left text-sm">
						<thead className="bg-panel text-fog">
							<tr>
								<th className="px-4 py-3 font-medium">Customer</th>
								{FEATURES.map((f) => (
									<th key={f} className="px-4 py-3 font-mono font-medium">
										{f}
									</th>
								))}
							</tr>
						</thead>
						<tbody className="divide-y divide-edge">
							{proof.customers.map((c) => (
								<tr key={c.current.customer}>
									<td className="px-4 py-3 font-medium">{c.current.customer_name}</td>
									{FEATURES.map((f) => (
										<td key={f} className="px-4 py-3">
											{c.current.features.includes(f) ? (
												<span className="text-mint">✓</span>
											) : (
												<span className="text-fog/40">—</span>
											)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="mt-3 text-sm text-fog">
					Every ✓ is an individually signed attestation — an agent can verify any single cell.
				</p>

				<section className="mt-14 rounded-lg border border-edge bg-panel p-6">
					<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Agent-readable</h2>
					<ul className="mt-4 space-y-2 font-mono text-sm">
						<li>
							<a className="text-mint hover:underline" href={`/proofs/${slug}.json`}>
								GET /proofs/{slug}.json
							</a>
							<span className="ml-3 text-fog">— this report</span>
						</li>
						<li>
							<a
								className="text-mint hover:underline"
								href={`/attest/${slug}/${proof.customers[0]?.current.customer}.json`}
							>
								GET /attest/{slug}/{proof.customers[0]?.current.customer}.json
							</a>
							<span className="ml-3 text-fog">— one attestation</span>
						</li>
						<li>
							<a
								className="text-mint hover:underline"
								href={`/attest/${slug}/${proof.customers[0]?.current.customer}/chain`}
							>
								GET /attest/{slug}/{proof.customers[0]?.current.customer}/chain
							</a>
							<span className="ml-3 text-fog">— its full signed history</span>
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

/** `2026-08-09T02:05:00Z` → `2026-08-09 02:05Z`, which fits on one line. */
function shortStamp(iso: string): string {
	return iso.replace("T", " ").replace(/:\d{2}(\.\d+)?Z$/, "Z");
}

function Tile({ label, value }: { label: string; value: string }) {
	return (
		<div className="bg-panel px-4 py-5">
			<dt className="text-xs tracking-wider text-fog uppercase">{label}</dt>
			<dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
		</div>
	);
}

function CustomerCard({ proof, vendor }: { proof: CustomerProof; vendor: string }) {
	const a = proof.current;

	return (
		<div className="rounded-lg border border-edge bg-panel p-5">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="text-lg font-medium">{a.customer_name}</h3>
				{a.verified ? (
					<span className="rounded-full border border-mint/30 bg-mint/10 px-2.5 py-0.5 text-xs font-medium text-mint">
						✓ Verified · tier {a.tier}
					</span>
				) : (
					// An unattested observation is still published, and labelled as
					// what it is. Rounding tier 1 up to "verified" is the one thing
					// that would make the whole surface worthless.
					<span className="rounded-full border border-edge px-2.5 py-0.5 text-xs text-fog">
						observed · tier {a.tier}
					</span>
				)}
			</div>

			<p className="mt-1 text-sm text-fog">Active since {a.since}</p>

			<dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
				<div>
					<dt className="text-fog">Sessions / 30d</dt>
					<dd className="tabular-nums">{a.sessions_30d.toLocaleString("en-US")}</dd>
				</div>
				<div>
					<dt className="text-fog">Seats active</dt>
					<dd className="tabular-nums">{a.seats_active}</dd>
				</div>
			</dl>

			<p className="mt-4 flex flex-wrap gap-1.5">
				{a.features.map((f) => (
					<span key={f} className="rounded border border-edge px-1.5 py-0.5 font-mono text-xs text-fog">
						{f}
					</span>
				))}
			</p>

			<p className="mt-4 border-t border-edge pt-3 font-mono text-xs text-fog">
				<a className="hover:text-mint" href={`/attest/${vendor}/${a.customer}.json`}>
					{a.key_id} · {a.signature.slice(0, 16)}…
				</a>
				<span className="ml-2">· {proof.chain.length} snapshots chained</span>
			</p>
		</div>
	);
}
