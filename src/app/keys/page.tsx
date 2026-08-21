import type { Metadata } from "next";
import { DevKeyBanner, SiteFooter, SiteHeader } from "@/components/chrome";
import { isDemonstration, jwks, signingMode } from "@/lib/attest/keys";
import { Badge, Card, Mono } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Signing keys — Letterprove",
	description: "The public keys Letterprove attestations are signed with, and why retired ones stay.",
};

/**
 * The human reading of the JWKS.
 *
 * The endpoint itself is unchanged — agents fetch /.well-known/letterprove-jwks.json
 * and always will. This is for the person who clicked "keys" in the nav and
 * got a wall of base64.
 *
 * The retired-keys explanation is the part worth surfacing: it looks like
 * clutter until you know that removing one silently invalidates history we
 * have told the world is immutable.
 */
export default function KeysPage() {
	const { keys } = jwks();
	const [active, ...retired] = keys;

	return (
		<>
			<DevKeyBanner />
			<SiteHeader />
			<main className="mx-auto max-w-3xl px-6 py-16">
				<h1 className="text-3xl font-semibold tracking-tight">Signing keys</h1>
				<p className="mt-3 leading-relaxed text-fog">
					The public half of every key an attestation here has ever been signed with. A verifier
					picks the one matching the <Mono>key_id</Mono> on the document it is checking.
				</p>

				<a
					href="/.well-known/letterprove-jwks.json"
					className="mt-6 inline-flex items-center gap-2 rounded border border-edge px-3 py-1.5 text-sm text-fog transition hover:border-mint hover:text-mint"
				>
					<Mono>/.well-known/letterprove-jwks.json</Mono>
					<span className="text-xs">the machine-readable version ↗</span>
				</a>

				<div className="mt-10 grid gap-4">
					{active && (
						<Card
							title="Active key"
							aside={
								<Badge tone={isDemonstration() ? "warn" : "mint"}>{signingMode()}</Badge>
							}
						>
							<KeyDetail jwk={active} />
							{isDemonstration() ? (
								<p className="mt-4 text-sm leading-relaxed text-amber-300">
									This is a published development key. Anything signed with it is a
									demonstration and is not evidence — anyone can forge under it.
								</p>
							) : (
								<p className="mt-4 text-sm leading-relaxed text-fog">
									The private half never sits on this service. Letterstory countersigns each
									snapshot after fraud scoring, so compromising this host does not let anyone
									mint a signature.
								</p>
							)}
						</Card>
					)}

					<Card title={retired.length ? `Retired keys (${retired.length})` : "Retired keys"}>
						<p className="text-sm leading-relaxed text-fog">
							Retired keys stay here forever, and that is deliberate. A proof issued today has
							to still verify years after the key that signed it leaves rotation — dropping one
							would silently invalidate history we have published as immutable.
						</p>
						{retired.length === 0 ? (
							<p className="mt-4 text-sm text-fog">No keys have been rotated out yet.</p>
						) : (
							<div className="mt-4 grid gap-3">
								{retired.map((k) => (
									<div key={k.kid} className="rounded border border-edge bg-ink/40 p-3">
										<KeyDetail jwk={k} />
									</div>
								))}
							</div>
						)}
					</Card>
				</div>
			</main>
			<SiteFooter />
		</>
	);
}

function KeyDetail({ jwk }: { jwk: { kid: string; kty: string; crv: string; alg: string; x: string } }) {
	return (
		<dl className="grid gap-3 sm:grid-cols-3">
			<Row label="Key ID" value={jwk.kid} wide />
			<Row label="Algorithm" value={`${jwk.alg} · ${jwk.crv}`} />
			<Row label="Type" value={jwk.kty} />
			<div className="sm:col-span-3">
				<dt className="text-[11px] tracking-widest text-fog uppercase">Public key</dt>
				<dd className="mt-1 overflow-x-auto rounded border border-edge bg-ink px-3 py-2 font-mono text-xs break-all text-mint">
					{jwk.x}
				</dd>
			</div>
		</dl>
	);
}

function Row({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
	return (
		<div className={wide ? "sm:col-span-1" : ""}>
			<dt className="text-[11px] tracking-widest text-fog uppercase">{label}</dt>
			<dd className="mt-1 font-mono text-sm break-all text-[#e9efed]">{value}</dd>
		</div>
	);
}
