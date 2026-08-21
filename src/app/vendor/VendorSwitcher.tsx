"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export interface VendorOption {
	id: string;
	name: string;
	slug: string;
	domain: string;
}

/**
 * Pick which of the signed-in user's vendors the dashboard is showing.
 *
 * Mirrors the org switcher in lettertrace (components/dashboard/org-switcher.tsx)
 * — optimistic label, a click-away layer, and a hard timeout so a switch that
 * silently no-ops cannot leave the UI pending forever. Rendered only when
 * there is more than one vendor: a menu with a single entry is furniture.
 *
 * "Add a vendor" carries ?new=1 deliberately. Onboarding redirects members
 * away by default, because a vendor created by accident used to be
 * unreachable — the switcher is what makes a second one visible, so this is
 * the one entry point that says the second vendor is intended.
 */
export function VendorSwitcher({
	vendors,
	activeId,
}: {
	vendors: VendorOption[];
	activeId: string;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [switching, setSwitching] = useState<VendorOption | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [, startTransition] = useTransition();
	const containerRef = useRef<HTMLDivElement>(null);

	const active = vendors.find((v) => v.id === activeId) ?? vendors[0];

	// Derived, not stored: a switch is pending only until the re-rendered
	// layout hands back the new activeId, and comparing the two says so
	// directly. Clearing it in an effect instead would be a second source of
	// truth for a fact already on screen.
	const pending = switching && switching.id !== activeId ? switching : null;
	// The vendor being switched to wins the label until the server catches up.
	const shown = pending ?? active;

	// Never spin forever. If the switch hasn't taken effect, drop the pending
	// state and resync rather than leaving a label that lies about what the
	// page below is showing.
	useEffect(() => {
		if (!pending) return;
		const timer = window.setTimeout(() => {
			setSwitching(null);
			router.refresh();
		}, 10000);
		return () => window.clearTimeout(timer);
	}, [pending, router]);

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	if (vendors.length < 2) return null;

	async function switchTo(vendor: VendorOption) {
		setOpen(false);
		setError(null);
		if (!active || vendor.id === active.id) return;
		setSwitching(vendor);
		try {
			const res = await fetch("/api/vendor/switch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ vendorId: vendor.id }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setSwitching(null);
				setError(body?.error ?? "Couldn't switch vendor.");
				return;
			}
			startTransition(() => {
				// Land on the dashboard: the page you were on belongs to the
				// vendor you just left.
				router.push("/vendor");
				router.refresh();
			});
		} catch {
			setSwitching(null);
			setError("Couldn't reach the server.");
		}
	}

	return (
		<div className="relative" ref={containerRef}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="listbox"
				aria-expanded={open}
				className="flex items-center gap-2 rounded border border-edge bg-panel px-2.5 py-1 text-left transition hover:border-mint/40"
			>
				<span className="max-w-[9rem] truncate text-xs font-medium text-[#e9efed]">
					{shown?.name ?? "Select vendor"}
				</span>
				<span className="text-[10px] text-fog" aria-hidden="true">
					▾
				</span>
			</button>

			{open && (
				<>
					<button
						type="button"
						aria-label="Close vendor menu"
						onClick={() => setOpen(false)}
						className="fixed inset-0 z-10 cursor-default"
						tabIndex={-1}
					/>
					<div
						role="listbox"
						className="absolute left-0 z-20 mt-2 min-w-[15rem] overflow-hidden rounded-lg border border-edge bg-panel shadow-[0_18px_44px_rgba(0,0,0,0.4)]"
					>
						<p className="px-3 pt-3 pb-1 text-[10px] tracking-widest text-fog uppercase">
							Your vendors
						</p>
						<ul className="max-h-64 overflow-y-auto pb-1 normal-case">
							{vendors.map((v) => {
								const isActive = v.id === active?.id;
								return (
									<li key={v.id}>
										<button
											type="button"
											role="option"
											aria-selected={isActive}
											onClick={() => switchTo(v)}
											className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition ${
												isActive ? "bg-mint/10" : "hover:bg-ink/60"
											}`}
										>
											<span className="min-w-0">
												<span
													className={`block truncate text-sm ${isActive ? "text-mint" : "text-[#e9efed]"}`}
												>
													{v.name}
												</span>
												<span className="block truncate font-mono text-[11px] text-fog">
													{v.domain}
												</span>
											</span>
											{isActive && (
												<span className="text-mint" aria-hidden="true">
													✓
												</span>
											)}
										</button>
									</li>
								);
							})}
						</ul>
						<Link
							href="/vendor/onboarding?new=1"
							onClick={() => setOpen(false)}
							className="block border-t border-edge px-3 py-2.5 text-sm text-fog normal-case transition hover:bg-ink/60 hover:text-mint"
						>
							+ Add a vendor
						</Link>
					</div>
				</>
			)}

			{pending && (
				<div
					className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-ink/85 backdrop-blur-sm"
					role="status"
					aria-live="polite"
				>
					<p className="font-medium text-[#e9efed]">{pending.name}</p>
					<p className="mt-1 text-sm text-fog normal-case">Switching vendor…</p>
				</div>
			)}

			{error && (
				<p className="absolute top-full left-0 mt-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs whitespace-nowrap text-red-300 normal-case">
					{error}
				</p>
			)}
		</div>
	);
}
