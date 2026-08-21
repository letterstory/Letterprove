"use client";

import { useEffect, useState } from "react";
import { Button, ErrorBanner } from "@/components/form";

/**
 * Domain and its verification state, in one card.
 *
 * They were two adjacent cards saying related things about the same value,
 * which read as clutter — and worse, split the answer to "is my domain
 * working?" across both. One card, with the status where the eye already is.
 *
 * The unverified state is deliberately the loud one: until the record is
 * published nothing is collected at all, so a quiet badge would leave a vendor
 * watching an empty dashboard with no idea why.
 */
export function DomainCard({
	domain,
	record,
	hosts,
	verifiedAt,
}: {
	domain: string;
	record: string | null;
	hosts: string[];
	verifiedAt: string | null;
}) {
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Seeded from the server-rendered prop, then updated in place on a
	// successful check — no page reload needed to see the badge go green.
	const [localVerifiedAt, setLocalVerifiedAt] = useState(verifiedAt);
	const verified = Boolean(localVerifiedAt);

	async function verifyNow(silent: boolean) {
		if (!silent) {
			setChecking(true);
			setError(null);
		}
		try {
			const res = await fetch("/api/vendor/verify-domain", { method: "POST" });
			const body = await res.json();
			if (body.verified) {
				setLocalVerifiedAt(body.verifiedAt);
				return;
			}
			if (!silent) setError(body.message ?? body.error ?? "Not verified yet.");
		} catch {
			if (!silent) setError("Couldn't reach the server. Try again.");
		} finally {
			if (!silent) setChecking(false);
		}
	}

	const check = () => verifyNow(false);

	// A vendor who adds the TXT record in another tab and switches back here
	// shouldn't have to hit refresh to see it go green — re-check quietly
	// whenever this tab regains focus, until it's verified.
	useEffect(() => {
		if (verified) return;
		function onVisible() {
			if (document.visibilityState === "visible") void verifyNow(true);
		}
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [verified]);

	return (
		<section
			className={`rounded-lg border bg-panel p-5 ${verified ? "border-edge" : "border-mint/40"}`}
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">Domain</h2>
				<span
					className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${
						verified ? "border-mint/40 text-mint" : "border-fog/40 text-fog"
					}`}
				>
					<span
						className={`h-1.5 w-1.5 rounded-full ${verified ? "bg-mint" : "bg-fog"}`}
						aria-hidden="true"
					/>
					{verified ? "Verified" : "Not verified"}
				</span>
			</div>

			<p className="mt-3 font-mono text-sm">{domain}</p>

			{verified ? (
				<p className="mt-2 text-sm text-fog">
					DNS control confirmed{" "}
					{new Date(localVerifiedAt!).toLocaleDateString("en-US", {
						month: "long",
						day: "numeric",
						year: "numeric",
					})}
					. This is the origin collection pins every event against, so changing it isn&apos;t
					self-service yet.
				</p>
			) : (
				<>
					<p className="mt-2 text-sm text-fog">
						<span className="text-mint">Nothing is collected until this is verified.</span>{" "}
						Anyone can type a domain into a form, so events are only counted once you&apos;ve shown
						you control {domain}.
					</p>

					{record && (
						<>
							<p className="mt-4 text-sm text-fog">
								Add a TXT record at <span className="font-mono text-xs">{hosts[0]}</span> — or on{" "}
								<span className="font-mono text-xs">{hosts[1]}</span>, whichever your DNS makes
								easier — with this value:
							</p>
							<pre className="mt-2 overflow-x-auto rounded border border-edge bg-ink p-3 font-mono text-sm text-mint">
								{record}
							</pre>
						</>
					)}

					<div className="mt-4 flex flex-wrap items-center gap-3">
						<Button type="button" onClick={check} disabled={checking}>
							{checking ? "Checking DNS…" : "Check now"}
						</Button>
						<span className="text-xs text-fog">DNS changes can take a few minutes to appear.</span>
					</div>

					{error && <ErrorBanner>{error}</ErrorBanner>}
				</>
			)}
		</section>
	);
}
