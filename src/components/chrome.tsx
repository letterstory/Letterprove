import Link from "next/link";
import { isDemonstration } from "@/lib/attest/keys";

/**
 * A banner that cannot be missed when proofs are signed with the development
 * key. The single worst outcome for this product is a demonstration being
 * mistaken for evidence, so the warning lives on the page, in the discovery
 * document, and in the key id itself.
 *
 * The second-worst outcome is the inverse, and it is the one that actually
 * happened: this asked `signingKey().isDev`, which stays true in production
 * forever now that Letterstory holds the key, so real countersigned proofs
 * were served under a "not evidence" banner. `isDemonstration()` asks what is
 * really signing. Getting this backwards is not a cosmetic bug — an agent that
 * reads the warning discounts the proof, which is the whole product.
 */
export function DevKeyBanner() {
	if (!isDemonstration()) return null;

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
				{/* Uppercase with letter-spacing: these are labels, not prose, and they
				    sit beside a wordmark rather than in a sentence. */}
				<nav className="flex items-center gap-5 text-xs tracking-widest text-fog uppercase">
					{/* These point at the human pages; each one links the raw
					    .well-known JSON at the top. The endpoints themselves are
					    unchanged — agents still fetch exactly what they always did. */}
					<Link className="hover:text-mint" href="/verify">
						verify
					</Link>
					<Link className="hover:text-mint" href="/keys">
						keys
					</Link>
					<a
						className="hover:text-mint"
						href="https://github.com/letterstory/Letterprove"
						rel="noreferrer"
					>
						source
					</a>
					<a
						className="hover:text-mint"
						href="https://www.npmjs.com/package/@letterstory/letterprove-cli"
						rel="noreferrer"
					>
						cli
					</a>
				</nav>
			</div>
		</header>
	);
}

export function SiteFooter() {
	return (
		<footer className="mt-20 border-t border-edge">
			<div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-fog">
				<span>
					Every attestation links to the open-source logic that computed it. A product of The
					Letter Company.
				</span>
				{/* Reachable from every public page: these get cited from contracts,
				    so a link that only exists on one page is a link nobody finds. */}
				<span className="flex items-center gap-3 whitespace-nowrap">
					<Link className="hover:text-mint" href="/privacy">
						Privacy
					</Link>
					<Link className="hover:text-mint" href="/terms">
						Terms
					</Link>
				</span>
			</div>
		</footer>
	);
}
