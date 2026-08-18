import type { ReactNode } from "react";
import Link from "next/link";
import { getUser } from "@/lib/auth/server";
import { StaffNav } from "./nav";
import { SignOutButton } from "./SignOutButton";

// Chrome depends on whether anyone is signed in, so this cannot be statically
// prerendered — the same reason every page beneath it carries the flag.
export const dynamic = "force-dynamic";

/**
 * The staff shell.
 *
 * Deliberately separate from the public chrome in components/chrome.tsx. That
 * header carries discovery, keys and source links, and exists to help an
 * evaluating agent verify a proof. None of that means anything here, and an
 * operations page rendered inside the product's own chrome invites reading it
 * as part of the product. It is not: nothing here is published, and everything
 * on it names customers who have not consented to be named.
 *
 * Each staff page previously hand-rolled its own header and nav, which drifted
 * — two of them linked differently and none showed which section you were in.
 * One shell, and every future page inherits it.
 *
 * Renders bare when signed out so /staff/login is not wrapped in navigation to
 * pages it cannot reach. The auth wall itself is middleware; this only decides
 * what chrome to draw.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
	const user = await getUser();
	if (!user) return <>{children}</>;

	return (
		<div className="min-h-screen bg-ink">
			<header className="border-b border-edge">
				<div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-4">
					<div className="flex items-center gap-4">
						<Link href="/staff" className="flex items-center gap-2">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src="/logo.svg" alt="Letterprove" className="h-5 w-auto" />
							<span className="font-mono text-xs text-mint">staff</span>
						</Link>
						<StaffNav />
					</div>
					<div className="flex items-center gap-4 text-sm">
						<Link href="/" className="text-fog hover:text-mint">
							public site
						</Link>
						<span className="hidden text-xs text-fog sm:inline">{user.email}</span>
						<SignOutButton />
					</div>
				</div>
			</header>
			<main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
		</div>
	);
}
