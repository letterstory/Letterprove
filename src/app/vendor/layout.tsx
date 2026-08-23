import type { ReactNode } from "react";
import Link from "next/link";
import { getUser } from "@/lib/auth/server";
import { currentVendor, vendorMemberships } from "@/lib/vendors/session";
import { VendorSwitcher } from "./VendorSwitcher";
import { VendorNav } from "./nav";
import { SignOutButton } from "./SignOutButton";

// Chrome depends on who is signed in and whether they have a vendor yet, so
// this cannot be statically prerendered — same reason every page beneath it
// carries the flag (see src/app/page.tsx).
export const dynamic = "force-dynamic";

/**
 * The vendor shell — a sidebar rather than a header strip.
 *
 * Everything used to live in one header row: wordmark, vendor switcher,
 * section tabs, CLI, public site, support, email, sign out. That put
 * navigation and account actions in the same visual group, which are
 * different kinds of thing, and left a fifth section nowhere to go without
 * crowding the wordmark.
 *
 * Now: identity and "where am I" down the left, account and outbound links
 * top right, sign out pinned to the bottom of the rail where a destructive
 * action is hard to hit by accident. Mirrors the sibling product's dashboard
 * so someone who uses both is not relearning the furniture.
 *
 * Renders bare when signed out, so /vendor/login isn't wrapped in nav to
 * pages it cannot reach. Renders without section nav when signed in but
 * membership-less — that's the /vendor/onboarding state, and a nav pointing
 * at pages that don't exist yet would be worse than none.
 */
export default async function VendorLayout({ children }: { children: ReactNode }) {
	const user = await getUser();
	if (!user) return <>{children}</>;

	const [vendor, memberships] = await Promise.all([currentVendor(), vendorMemberships()]);

	return (
		<div className="min-h-screen bg-ink md:flex">
			{/*
			 * Sticky, full-height, its own scroll. On a phone it becomes a normal
			 * block at the top with the nav wrapping — a fixed sidebar on a small
			 * screen costs more width than the content can spare.
			 */}
			<aside className="border-b border-edge md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:border-r md:border-b-0">
				<div className="flex items-center gap-2 px-5 py-4">
					<Link
						href={vendor ? "/vendor" : "/vendor/onboarding"}
						className="flex items-center gap-2"
					>
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img src="/logo.svg" alt="Letterprove" className="h-5 w-auto" />
						<span className="font-mono text-xs text-mint">vendor</span>
					</Link>
				</div>

				{vendor && memberships.length > 1 && (
					<div className="px-4 pb-3">
						<VendorSwitcher vendors={memberships} activeId={vendor.id} />
					</div>
				)}

				{vendor && (
					<div className="px-3 pb-4 md:flex-1 md:overflow-y-auto">
						<VendorNav />
					</div>
				)}

				{/*
				 * Pinned to the bottom, away from navigation. Signing out sits with
				 * the account it ends, not among the links someone clicks all day.
				 * The address stays as typed — uppercasing an email misrepresents it.
				 */}
				<div className="hidden border-t border-edge px-4 py-3 md:block">
					<p className="truncate text-xs text-fog" title={user.email}>
						{user.email}
					</p>
					<div className="mt-2">
						<SignOutButton />
					</div>
				</div>
			</aside>

			<div className="min-w-0 flex-1">
				{/* Outbound and account links: not section navigation, so not in the
				    rail. Sign out repeats here only on phones, where the rail's
				    bottom block is hidden. */}
				<header className="flex flex-wrap items-center justify-end gap-4 px-6 py-4 text-xs tracking-widest uppercase">
					<a
						href="https://www.npmjs.com/package/@letterstory/letterprove-cli"
						className="text-fog hover:text-mint"
						rel="noreferrer"
					>
						cli
					</a>
					{/* Points at the vendor's OWN published proof, not the index. A
					    vendor wants to see what a buyer sees of THEM; the index is
					    for buyers and agents. */}
					<Link href={vendor ? `/proofs/${vendor.slug}` : "/"} className="text-fog hover:text-mint">
						{vendor ? "your public proof" : "public site"}
					</Link>
					<Link href="/vendor/support" className="text-fog hover:text-mint">
						support
					</Link>
					<span className="md:hidden">
						<SignOutButton />
					</span>
				</header>

				<main className="vendor-main mx-auto max-w-5xl px-6 pb-12">{children}</main>
			</div>
		</div>
	);
}
