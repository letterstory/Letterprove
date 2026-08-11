import Link from "next/link";
import { signingKey } from "@/lib/attest/keys";

/**
 * A banner that cannot be missed when proofs are signed with the development
 * key. The single worst outcome for this product is a demonstration being
 * mistaken for evidence, so the warning lives on the page, in the discovery
 * document, and in the key id itself.
 */
export function DevKeyBanner() {
	if (!signingKey().isDev) return null;

	return (
		<div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2.5 text-center text-sm text-amber-200">
			<strong className="font-semibold">Development deployment.</strong> Signed with a published
			development key over fixture data — <em>not evidence</em>.
		</div>
	);
}

export function SiteHeader() {
	return (
		<header className="border-b border-edge">
			<div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
				<Link href="/" className="flex items-center gap-3">
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src="/logo.svg" alt="Letterprove" className="h-6 w-auto" />
				</Link>
				<nav className="flex items-center gap-5 text-sm text-fog">
					<a className="hover:text-mint" href="/.well-known/letterprove.json">
						discovery
					</a>
					<a className="hover:text-mint" href="/.well-known/letterprove-jwks.json">
						keys
					</a>
					<a
						className="hover:text-mint"
						href="https://github.com/letterstory/Letterprove"
						rel="noreferrer"
					>
						source
					</a>
				</nav>
			</div>
		</header>
	);
}

export function SiteFooter() {
	return (
		<footer className="mt-20 border-t border-edge">
			<div className="mx-auto max-w-5xl px-6 py-8 text-sm text-fog">
				Every attestation links to the open-source logic that computed it. A product of The Letter
				Company.
			</div>
		</footer>
	);
}
