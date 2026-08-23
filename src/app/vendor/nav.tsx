"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

/**
 * Vendor section nav — a vertical rail on desktop, a wrapping row on phones.
 *
 * Was a horizontal tab strip with a sliding indicator. The rail replaces it
 * for two reasons beyond matching the sibling product: a fifth section had
 * nowhere to go without crowding the wordmark, and section nav in the header
 * competed with account actions (sign out, support) that are not navigation
 * at all. Splitting them puts "where am I" on the left and "my account" top
 * right, which is where people already look.
 *
 * The pending state is kept from the old strip. Every /vendor page is
 * force-dynamic and queries the database, so a click has a real round-trip
 * behind it; without this the click reads as ignored until the new page
 * paints. useLinkStatus is Next's own signal rather than hand-tracked state.
 */
const ITEMS = [
	{ href: "/vendor", label: "Dashboard", exact: true },
	{ href: "/vendor/observed", label: "Observed" },
	{ href: "/vendor/customers", label: "Customers" },
	{ href: "/vendor/proof", label: "Proof" },
];

export function VendorNav() {
	const pathname = usePathname() ?? "";

	return (
		<nav className="flex flex-row flex-wrap gap-1 md:flex-col md:flex-nowrap md:gap-0.5">
			{ITEMS.map((item) => {
				const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
				return (
					<Link
						key={item.href}
						href={item.href}
						aria-current={active ? "page" : undefined}
						className={`group relative rounded-lg px-3.5 py-2.5 text-[15px] font-medium transition-colors ${
							active ? "bg-mint/10 text-mint" : "text-fog hover:bg-ink/60 hover:text-[#e9efed]"
						}`}
					>
						{/* A rail rather than an underline: it reads as "you are here"
						    in a vertical list, where an underline reads as a link. */}
						<span
							aria-hidden="true"
							className={`absolute top-2 bottom-2 -left-px w-[3px] rounded-full transition-colors ${
								active ? "bg-mint" : "bg-transparent"
							}`}
						/>
						<NavLabel>{item.label}</NavLabel>
					</Link>
				);
			})}
		</nav>
	);
}

/** Dims the instant the link is pressed, so the wait feels answered. */
function NavLabel({ children }: { children: React.ReactNode }) {
	const { pending } = useLinkStatus();
	return <span className={pending ? "opacity-50" : undefined}>{children}</span>;
}
