"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * The action on a `no-customer-record` row.
 *
 * Deliberately says "Record" and not "Add customer": it creates an anonymous
 * record with a provisional name, which contributes to the aggregate and earns
 * a tier from evidence. It does not name anyone publicly, and the caption says
 * so rather than leaving an operator to infer it from the consent model.
 *
 * Errors are shown, never swallowed. The refusals this can hit — not observed,
 * already exists, unattributable — are all things the operator needs to read,
 * because each one means the page they are looking at disagrees with the
 * database.
 */
export function PromoteButton({ vendor, domain }: { vendor: string; domain: string }) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function promote() {
		setBusy(true);
		setError(null);

		const res = await fetch("/api/staff/customers", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ vendor, domain }),
		}).catch(() => null);

		if (!res?.ok) {
			const body = await res?.json().catch(() => null);
			setError(body?.detail ?? body?.error ?? "request failed");
			setBusy(false);
			return;
		}

		// Re-render the server component so the row moves to its new status
		// rather than this button guessing what it became.
		startTransition(() => {
			router.refresh();
			setBusy(false);
		});
	}

	return (
		<div className="flex flex-col items-start gap-1">
			<button
				onClick={promote}
				disabled={busy || pending}
				className="rounded-md border border-mint/30 bg-mint/10 px-2.5 py-1 text-xs text-mint transition hover:bg-mint/20 disabled:opacity-50"
			>
				{busy || pending ? "Recording…" : "Record as customer"}
			</button>
			{error && <span className="text-xs text-amber-200">{error}</span>}
		</div>
	);
}
