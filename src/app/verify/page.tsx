import type { Metadata } from "next";
import { headers } from "next/headers";
import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { discoveryDocument } from "@/lib/attest/discovery";
import { Card, Mono } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Verify — Letterprove",
	description: "How to check a Letterprove attestation yourself, and what the discovery document says.",
};

/**
 * The human reading of /.well-known/letterprove.json.
 *
 * That document is for agents and stays exactly as it is — a machine endpoint
 * that changes shape to suit a browser is a worse endpoint. But the nav sent
 * people there too, and a wall of JSON is a poor answer to "how do I know any
 * of this is real?". This renders the same document, built by the same
 * function, and links the raw version at the top so neither audience is
 * treated as an afterthought.
 */
export default async function VerifyPage() {
	const host = (await headers()).get("host") ?? "app.letterprove.com";
	const proto = host.startsWith("localhost") ? "http" : "https";
	const origin = `${proto}://${host}`;
	const doc = await discoveryDocument(origin);

	return (
		<>
			<DevKeyBanner />
			<SiteHeader />
			<main className="mx-auto max-w-3xl px-6 py-16">
				<h1 className="text-3xl font-semibold tracking-tight">
					How to verify any of this
				</h1>
				<p className="mt-3 leading-relaxed text-fog">
					Every attestation is signed, chained to the one before it, and carries a commit-pinned
					link to the code that computed it. Nothing below asks you to trust us — it tells you
					where to check.
				</p>

				<a
					href="/.well-known/letterprove.json"
					className="mt-6 inline-flex items-center gap-2 rounded border border-edge px-3 py-1.5 text-sm text-fog transition hover:border-mint hover:text-mint"
				>
					<Mono>/.well-known/letterprove.json</Mono>
					<span className="text-xs">the machine-readable version ↗</span>
				</a>

				<div className="mt-10 grid gap-4">
					<Card title="Run the verifier">
						<p className="text-sm leading-relaxed text-fog">
							A standalone script with no dependencies. It re-implements canonicalisation
							rather than importing ours, so when it agrees the agreement means something.
						</p>
						<pre className="mt-3 overflow-x-auto rounded border border-edge bg-ink p-3 font-mono text-sm text-mint">
							npm run verify -- {origin}/attest/&lt;vendor&gt;/chain
						</pre>
						<p className="mt-2 text-sm text-fog">
							Point it at a chain, not a single document: it checks every signature and every{" "}
							<Mono>prev_hash</Mono> link, then prints the provenance tier the evidence earned.
						</p>
						<a
							href={doc.verifier}
							className="mt-3 inline-block text-sm text-mint hover:underline"
							rel="noreferrer"
						>
							Read the verifier source ↗
						</a>
					</Card>

					<Card title="How signatures are made">
						<dl className="grid gap-3 sm:grid-cols-2">
							<Detail label="Algorithm" value={`${doc.signing.alg} (${doc.signing.crv})`} />
							<Detail
								label="Signing mode"
								value={doc.signing.mode}
								hint={
									doc.warning
										? "A development key. These attestations are demonstrations, not evidence."
										: "Countersigned by Letterstory after fraud scoring, so the key never sits on this service."
								}
							/>
						</dl>
						<div className="mt-4 grid gap-2">
							<LinkRow href="/keys" label="Signing keys" description="the public half, in readable form" />
							<LinkRow
								href={doc.signing.canonicalization}
								label="Canonicalisation"
								description="exactly which bytes get signed, pinned to a commit"
								external
							/>
						</div>
					</Card>

					<Card title={`Published proofs (${doc.proofs.length})`}>
						{doc.proofs.length === 0 ? (
							<p className="text-sm text-fog">Nothing is published yet.</p>
						) : (
							<ul className="grid gap-2">
								{doc.proofs.map((p) => (
									<li
										key={p.vendor}
										className="rounded border border-edge bg-ink/40 px-3 py-2.5 transition hover:border-mint/40"
									>
										<a href={p.url} className="font-medium text-[#e9efed] hover:text-mint">
											{p.vendor}
										</a>
										<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
											<a href={p.aggregate} className="font-mono text-fog hover:text-mint">
												signed attestation
											</a>
											<span className="text-fog/40" aria-hidden="true">·</span>
											<a href={p.aggregate_chain} className="font-mono text-fog hover:text-mint">
												full chain
											</a>
										</div>
									</li>
								))}
							</ul>
						)}
					</Card>
				</div>
			</main>
			<SiteFooter />
		</>
	);
}

function Detail({ label, value, hint }: { label: string; value: string; hint?: string }) {
	return (
		<div>
			<dt className="text-[11px] tracking-widest text-fog uppercase">{label}</dt>
			<dd className="mt-1 font-mono text-sm text-[#e9efed]">{value}</dd>
			{hint && <dd className="mt-1 text-xs leading-relaxed text-fog">{hint}</dd>}
		</div>
	);
}

function LinkRow({
	href,
	label,
	description,
	external,
}: {
	href: string;
	label: string;
	description: string;
	external?: boolean;
}) {
	return (
		<a
			href={href}
			{...(external ? { rel: "noreferrer" } : {})}
			className="flex flex-wrap items-baseline gap-x-3 rounded border border-edge bg-ink/40 px-3 py-2 transition hover:border-mint/40"
		>
			<span className="text-sm font-medium text-mint">
				{label} {external ? "↗" : "→"}
			</span>
			<span className="text-xs text-fog">{description}</span>
		</a>
	);
}
