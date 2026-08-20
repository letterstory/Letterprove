"use client";

import { useEffect, useState } from "react";

type Status =
	| { state: "loading" }
	| { state: "ok"; receiving: boolean; count: number }
	| { state: "error" };

/** GET /api/vendor/status on mount — the dashboard's "is this vendor receiving events?" check. */
export function StatusIndicator() {
	const [status, setStatus] = useState<Status>({ state: "loading" });

	useEffect(() => {
		let cancelled = false;

		fetch("/api/vendor/status")
			.then((res) => {
				if (!res.ok) throw new Error(`status ${res.status}`);
				return res.json();
			})
			.then((data: { receiving: boolean; count: number }) => {
				if (!cancelled) setStatus({ state: "ok", receiving: data.receiving, count: data.count });
			})
			.catch(() => {
				if (!cancelled) setStatus({ state: "error" });
			});

		return () => {
			cancelled = true;
		};
	}, []);

	if (status.state === "loading") {
		return (
			<p className="flex items-center gap-2 text-sm text-fog">
				<span className="h-2 w-2 animate-pulse rounded-full bg-fog" />
				Checking for events…
			</p>
		);
	}

	if (status.state === "error") {
		return (
			<p className="flex items-center gap-2 text-sm text-red-300">
				<span className="h-2 w-2 rounded-full bg-red-400" />
				Couldn&apos;t check event status.
			</p>
		);
	}

	if (!status.receiving) {
		return (
			<p className="flex items-center gap-2 text-sm text-fog">
				<span className="h-2 w-2 rounded-full bg-amber-400" />
				Waiting for events…
			</p>
		);
	}

	return (
		<p className="flex items-center gap-2 text-sm text-mint">
			<span className="h-2 w-2 rounded-full bg-mint" />
			Receiving events — {status.count} in the last 24h
		</p>
	);
}
