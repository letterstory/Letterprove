"use client";

import { useSyncExternalStore } from "react";

/**
 * When a proof was last attested, in the reader's own timezone.
 *
 * Client components for one reason: the server has no idea where the reader
 * is. The tile used to render `2026-08-23 22:05Z`, which is precise and asks a
 * buyer to do UTC arithmetic to answer "is this current?" — the only question
 * it exists to answer.
 *
 * Both use useSyncExternalStore rather than useState + useEffect. That is the
 * primitive React provides for values that genuinely differ between server and
 * client: it takes an explicit server snapshot, so the divergence is declared
 * rather than papered over, and it avoids the cascading render that setting
 * state inside an effect causes (the rule the lint config enforces).
 */

/** Never emits. The server/client difference is fixed at hydration. */
const subscribeNever = () => () => {};

function useHydrated(): boolean {
	return useSyncExternalStore(
		subscribeNever,
		() => true,
		() => false
	);
}

/**
 * A clock that ticks once a minute, shared by every instance on the page.
 *
 * The snapshot MUST be cached — useSyncExternalStore compares snapshots by
 * identity, and returning a fresh Date.now() on every call would re-render
 * forever. So the interval writes `now` and getSnapshot just reads it.
 */
let now = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribeToMinute(onChange: () => void): () => void {
	listeners.add(onChange);
	if (!timer) {
		now = Date.now();
		timer = setInterval(() => {
			now = Date.now();
			for (const l of listeners) l();
		}, 60_000);
	}
	return () => {
		listeners.delete(onChange);
		if (listeners.size === 0 && timer) {
			clearInterval(timer);
			timer = null;
		}
	};
}

function useMinuteClock(): number {
	return useSyncExternalStore(
		subscribeToMinute,
		() => now || (now = Date.now()),
		() => 0
	);
}

/** `2026-08-09T02:05:00Z` → `2026-08-09 02:05Z`. The server-safe form. */
function utcShort(iso: string): string {
	return iso.replace("T", " ").replace(/:\d{2}(\.\d+)?Z$/, "Z");
}

export function AttestedAt({ iso }: { iso: string }) {
	const hydrated = useHydrated();

	if (!iso) return <span className="text-fog/40">—</span>;

	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return <span className="text-fog/40">—</span>;

	// The UTC form renders first and is replaced after hydration, so the value
	// is never missing, never shifts layout, and still says something true with
	// JavaScript disabled. The title keeps the exact instant available.
	return (
		<span suppressHydrationWarning title={iso}>
			{hydrated
				? d.toLocaleString(undefined, {
						month: "short",
						day: "numeric",
						hour: "numeric",
						minute: "2-digit",
					})
				: utcShort(iso)}
		</span>
	);
}

/**
 * "3 hours ago", under the timestamp. Freshness is the real question — a proof
 * attested last month and one attested an hour ago look identical as absolute
 * dates until the reader does the subtraction.
 */
export function RelativeAge({ iso }: { iso: string }) {
	const nowMs = useMinuteClock();

	if (!iso || nowMs === 0) return null;
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return null;

	const mins = Math.round((nowMs - then) / 60_000);
	// A future timestamp means clock skew between us and the reader, not a
	// prediction. Say nothing rather than "in 3 minutes".
	if (mins < 0) return null;

	let text: string;
	if (mins < 1) text = "just now";
	else if (mins < 60) text = `${mins} min ago`;
	else {
		const hours = Math.round(mins / 60);
		if (hours < 24) text = `${hours} hour${hours === 1 ? "" : "s"} ago`;
		else {
			const days = Math.round(hours / 24);
			text = `${days} day${days === 1 ? "" : "s"} ago`;
		}
	}

	return (
		<span suppressHydrationWarning className="text-xs font-normal text-fog">
			{text}
		</span>
	);
}
