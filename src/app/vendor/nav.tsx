"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * Vendor section tabs.
 *
 * Two things beyond a list of links:
 *
 * 1. A single indicator that slides between tabs, rather than a background
 *    that pops on and off. It is measured from the active tab's own box, so
 *    it stays correct when a label changes or a tab is added — nothing is
 *    hardcoded to three equal widths.
 *
 * 2. An immediate pending state, from Next's own useLinkStatus rather than
 *    hand-tracked state. Every page under /vendor is force-dynamic and
 *    queries the database, so a click has nothing to show for a beat. The tab
 *    dims the moment it is pressed, which makes the wait feel answered rather
 *    than ignored — the skeletons in each loading.tsx do the rest.
 */
const TABS = [
	{ href: "/vendor", label: "Dashboard", match: (p: string) => p === "/vendor" },
	{ href: "/vendor/customers", label: "Customers", match: (p: string) => p.startsWith("/vendor/customers") },
	{ href: "/vendor/proof", label: "Proof", match: (p: string) => p.startsWith("/vendor/proof") },
];

export function VendorNav() {
	const pathname = usePathname() ?? "";
	const activeIndex = Math.max(0, TABS.findIndex((t) => t.match(pathname)));

	const containerRef = useRef<HTMLElement>(null);
	const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);
	const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

	useLayoutEffect(() => {
		function place() {
			const el = tabRefs.current[activeIndex];
			const container = containerRef.current;
			if (!el || !container) return;
			setIndicator({
				left: el.offsetLeft - container.clientLeft,
				width: el.offsetWidth,
			});
		}
		place();

		// Fonts landing after hydration change tab widths, so re-measure.
		const observer = new ResizeObserver(place);
		if (containerRef.current) observer.observe(containerRef.current);
		return () => observer.disconnect();
	}, [activeIndex]);

	return (
		<nav
			ref={containerRef}
			className="relative flex items-center gap-1 rounded-md border border-edge bg-panel p-1"
		>
			{indicator && (
				<span
					aria-hidden="true"
					className="absolute top-1 bottom-1 rounded-sm bg-mint/10 ring-1 ring-mint/25 transition-[left,width] duration-300 ease-out motion-reduce:transition-none"
					style={{ left: indicator.left, width: indicator.width }}
				/>
			)}

			{TABS.map((tab, i) => {
				const active = i === activeIndex;
				return (
					<Link
						key={tab.href}
						href={tab.href}
						ref={(el) => {
							tabRefs.current[i] = el;
						}}
						aria-current={active ? "page" : undefined}
						className="relative z-10 rounded-sm px-3 py-1 text-[11px] tracking-widest uppercase"
					>
						<TabLabel label={tab.label} active={active} />
					</Link>
				);
			})}
		</nav>
	);
}

/**
 * Must be a child of the Link — useLinkStatus reports the pending state of the
 * navigation its enclosing Link started, which is exactly the beat between the
 * click and the new page's first byte.
 */
function TabLabel({ label, active }: { label: string; active: boolean }) {
	const { pending } = useLinkStatus();
	return (
		<span
			className={`transition-colors duration-200 ${
				active
					? "font-medium text-mint"
					: pending
						? "text-mint/70"
						: "text-fog hover:text-mint"
			}`}
		>
			{label}
		</span>
	);
}
