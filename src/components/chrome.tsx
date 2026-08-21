import Link from "next/link";
import { isDemonstration } from "@/lib/attest/keys";
import { getUser } from "@/lib/auth/server";

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

export async function SiteHeader() {
	// Server component, so it can tell a signed-in visitor from a stranger and
	// stop offering to sign in someone who already is.
	const user = await getUser().catch(() => null);

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
					<a
						className="hover:text-mint"
						href="https://www.npmjs.com/package/@letterstory/letterprove-cli"
						rel="noreferrer"
					>
						cli
					</a>
					<Link
						href={user ? "/vendor" : "/vendor/login"}
						className="rounded border border-edge px-3 py-1.5 text-fog hover:border-mint hover:text-mint"
					>
						{user ? "vendor dashboard" : "vendor sign in"}
					</Link>
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
