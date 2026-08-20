"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Vendor section tabs — mirrors src/app/staff/nav.tsx's shape so the two
 * signed-in surfaces read the same way, in the same tokens.
 */
const TABS = [
	{ href: "/vendor", label: "Dashboard", match: (p: string) => p === "/vendor" },
	{ href: "/vendor/customers", label: "Customers", match: (p: string) => p.startsWith("/vendor/customers") },
	{ href: "/vendor/proof", label: "Proof", match: (p: string) => p.startsWith("/vendor/proof") },
];

export function VendorNav() {
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
