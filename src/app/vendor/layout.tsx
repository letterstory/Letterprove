import type { ReactNode } from "react";
import Link from "next/link";
import { getUser } from "@/lib/auth/server";
import { currentVendor } from "@/lib/vendors/session";
import { VendorNav } from "./nav";
import { SignOutButton } from "./SignOutButton";

// Chrome depends on who is signed in and whether they have a vendor yet, so
// this cannot be statically prerendered — same reason every page beneath it
// carries the flag (see src/app/page.tsx).
export const dynamic = "force-dynamic";

/**
 * The vendor shell — mirrors src/app/staff/layout.tsx's shape (one shell,
 * every /vendor/* page inherits it, instead of each page hand-rolling its
 * own header and drifting).
 *
 * Renders bare when signed out, so /vendor/login isn't wrapped in nav to
 * pages it cannot reach. Renders without the section tabs when signed in
 * but membership-less — that's exactly the /vendor/onboarding state, and a
 * Dashboard/Customers/Proof nav pointing at pages that don't exist yet
 * would be worse than none.
 */
export default async function VendorLayout({ children }: { children: ReactNode }) {
	const user = await getUser();
	if (!user) return <>{children}</>;

	const vendor = await currentVendor();

	return (
		<div className="min-h-screen bg-ink">
			<header className="border-b border-edge">
				<div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
					<div className="flex items-center gap-4">
						<Link href={vendor ? "/vendor" : "/vendor/onboarding"} className="flex items-center gap-2">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src="/logo.svg" alt="Letterprove" className="h-5 w-auto" />
							<span className="font-mono text-xs text-mint">vendor</span>
						</Link>
						{vendor && <VendorNav />}
					</div>
					<div className="flex items-center gap-4 text-xs tracking-widest uppercase">
						<a
							href="https://www.npmjs.com/package/@letterstory/letterprove-cli"
							className="text-fog hover:text-mint"
							rel="noreferrer"
						>
							cli
						</a>
						<Link href="/" className="text-fog hover:text-mint">
							public site
						</Link>
						{/* The address stays as typed — uppercasing an email misrepresents it. */}
						<span className="hidden text-xs normal-case text-fog sm:inline">{user.email}</span>
						<SignOutButton />
					</div>
				</div>
			</header>
			<main className="vendor-main mx-auto max-w-5xl px-6 py-10">{children}</main>
		</div>
	);
}
