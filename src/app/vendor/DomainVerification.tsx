"use client";

import { useState } from "react";
import { Button, ErrorBanner, Notice } from "@/components/form";

/**
 * The domain-verification card.
 *
 * Deliberately loud when unverified: until the record is published, nothing
 * this vendor collects can earn a tier above 0, so a quiet badge would leave
 * them wondering why their proofs stay empty while traffic arrives.
 */
export function DomainVerification({
	domain,
	record,
	hosts,
	verifiedAt,
}: {
	domain: string;
	record: string;
	hosts: string[];
	verifiedAt: string | null;
}) {
	const [state, setState] = useState<{ checking: boolean; message: string | null; ok: boolean }>({
		checking: false,
		message: null,
		ok: Boolean(verifiedAt),
	});

	async function check() {
		setState((s) => ({ ...s, checking: true, message: null }));
		try {
			const res = await fetch("/api/vendor/verify-domain", { method: "POST" });
			const body = await res.json();
			setState({ checking: false, ok: Boolean(body.verified), message: body.message ?? body.error ?? null });
			if (body.verified) window.location.reload();
		} catch {
			setState({ checking: false, ok: false, message: "Couldn't reach the server. Try again." });
		}
	}

	if (verifiedAt) {
		return (
			<section className="rounded-lg border border-edge bg-panel p-5">
				<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Domain verification</h2>
				<p className="mt-2 text-sm">
					<span className="text-mint">Verified</span>{" "}
					<span className="text-fog">
						— DNS control of {domain} confirmed{" "}
						{new Date(verifiedAt).toLocaleDateString("en-US", {
							month: "short",
							day: "numeric",
							year: "numeric",
						})}
						.
					</span>
				</p>
			</section>
		);
	}

	return (
		<section className="rounded-lg border border-mint/40 bg-panel p-5">
			<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Domain verification</h2>
			<p className="mt-2 text-sm">
				<span className="text-mint">Not verified yet.</span>{" "}
				<span className="text-fog">
					Anyone can type a domain into a form, so until you prove you control {domain}, what we collect
					stays an assertion — your proofs will publish at tier 0 however much traffic arrives.
				</span>
			</p>

			<p className="mt-4 text-sm text-fog">
				Add a TXT record at <span className="font-mono text-xs">{hosts[0]}</span> (or on{" "}
				<span className="font-mono text-xs">{hosts[1]}</span> if that&apos;s easier) with this value:
			</p>
			<pre className="mt-2 overflow-x-auto rounded border border-edge bg-ink p-3 font-mono text-sm text-mint">
				{record}
			</pre>

			<div className="mt-4 flex flex-wrap items-center gap-3">
				<Button type="button" onClick={check} disabled={state.checking}>
					{state.checking ? "Checking DNS…" : "Check now"}
				</Button>
				<span className="text-xs text-fog">DNS changes can take a few minutes to propagate.</span>
			</div>

			{state.message && !state.ok && <ErrorBanner>{state.message}</ErrorBanner>}
			{state.message && state.ok && <Notice>{state.message}</Notice>}
		</section>
	);
}
