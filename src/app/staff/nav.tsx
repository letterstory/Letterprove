"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Staff section tabs.
 *
 * Client-side only for `usePathname` — there is no state here. Mirrors the
 * shape of lettertrace's admin nav so the two operations surfaces read the
 * same way, in Letterprove's own tokens rather than lettertrace's.
 *
 * `match` rather than an href equality check, so a future detail page (one
 * vendor, one customer) highlights the section it belongs to. The tab answers
 * "which section am I in", not "which URL is this".
 */
const TABS = [
	{ href: "/staff", label: "Collection", match: (p: string) => p === "/staff" },
	{ href: "/staff/vendors", label: "Vendors", match: (p: string) => p.startsWith("/staff/vendors") },
	{ href: "/staff/tiers", label: "Tiers", match: (p: string) => p.startsWith("/staff/tiers") },
];

export function StaffNav() {
	const pathname = usePathname() ?? "";

	return (
		<nav className="flex items-center gap-1 rounded border border-edge bg-panel p-1">
			{TABS.map((tab) => {
				const active = tab.match(pathname);
				return (
					<Link
						key={tab.href}
						href={tab.href}
						aria-current={active ? "page" : undefined}
						className={`rounded-sm px-2.5 py-1 text-xs transition ${
							active ? "bg-mint/10 font-medium text-mint" : "text-fog hover:text-mint"
						}`}
					>
						{tab.label}
					</Link>
				);
			})}
		</nav>
	);
}
