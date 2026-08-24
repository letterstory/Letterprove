"use client";

import { useState } from "react";
import { Button, ErrorBanner, Field, TextInput } from "@/components/form";
import { Badge, Card } from "@/components/ui";

/**
 * Connecting Stripe, and what it bought you.
 *
 * Modelled on DomainCard: one card that answers "is this working?" where the
 * eye already is, with the not-yet state carrying the explanation rather than a
 * quiet badge. Same reasoning applies here — a vendor who connects a key and
 * sees nothing change has no way to tell whether it worked.
 *
 * Test mode is called out loudly rather than treated as a lesser success. A
 * test key syncs, reports real counts, and produces NO published evidence, so
 * a vendor who connects one and walks away would otherwise believe their
 * proofs are payment-backed when nothing was stored.
 */

export interface StripeConnectionView {
	last4: string;
	livemode: boolean;
	connectedAt: string;
	lastSyncedAt: string | null;
	lastSyncError: string | null;
}

interface SyncSummary {
	matched: number;
	unmatched: number;
	testMode: boolean;
	truncated: boolean;
}

function shortDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function StripeCard({ connection }: { connection: StripeConnectionView | null }) {
	const [current, setCurrent] = useState(connection);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [summary, setSummary] = useState<SyncSummary | null>(null);

	async function call(path: string, body?: unknown) {
		const res = await fetch(path, {
			method: body === undefined ? "DELETE" : "POST",
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
		const json = await res.json().catch(() => null);
		if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
		return json;
	}

	async function connect() {
		setBusy("connect");
		setError(null);
		try {
			const { connection: next } = await call("/api/vendor/stripe", { key });
			setCurrent(next);
			setKey("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't connect Stripe.");
		} finally {
			setBusy(null);
		}
	}

	async function sync() {
		setBusy("sync");
		setError(null);
		setSummary(null);
		try {
			const result = await call("/api/vendor/stripe/sync", {});
			setSummary(result.summary);
			if (result.connection) setCurrent(result.connection);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't sync from Stripe.");
		} finally {
			setBusy(null);
		}
	}

	async function disconnect() {
		setBusy("disconnect");
		setError(null);
		try {
			await call("/api/vendor/stripe");
			setCurrent(null);
			setSummary(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't disconnect.");
		} finally {
			setBusy(null);
		}
	}

	return (
		<Card
			title="Stripe"
			aside={
				current ? (
					<Badge tone={current.livemode ? "mint" : "warn"}>
						{current.livemode ? "connected" : "test mode"}
					</Badge>
				) : (
					<Badge tone="neutral">not connected</Badge>
				)
			}
		>
			{error && (
				<div className="mb-4">
					<ErrorBanner>{error}</ErrorBanner>
				</div>
			)}

			{!current ? (
				<div className="grid gap-4">
					<p className="text-sm leading-relaxed text-fog">
						Connecting Stripe lets a claim say{" "}
						<strong className="text-[#e9efed]">what a customer actually pays</strong> — read from
						your Stripe account, not asserted by you. That&rsquo;s what raises a proof to tier 3:
						the evidence stops passing through your hands, so nobody has to take your word for it.
					</p>
					{/* Walks both screens Stripe actually shows. Found by doing it:
					    the flow asks how the key will be used, then offers
					    permission templates where EVERY option grants 30-40
					    permissions and the correct choice is a small "Choose your
					    own" link. A vendor following vaguer instructions lands on
					    that screen and picks a template, ending up with 34
					    permissions instead of 2 — which would make our own "we
					    only ask for what we need" claim false in practice. */}
					<Field label="Restricted API key" hint="Starts with rk_live_ or rk_test_.">
						<TextInput
							value={key}
							onChange={(e) => setKey(e.target.value)}
							placeholder="rk_live_…"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>
					{/*
					 * A link, not the menu path it replaced ("Stripe → Developers →
					 * API keys"). Menu paths rot: Stripe moved its own Connect
					 * settings between the page their docs named and the one that
					 * actually holds it, and a vendor following stale directions
					 * gives up somewhere we never hear about. A URL survives a
					 * dashboard reorganisation.
					 *
					 * Outside the Field on purpose — `hint` renders inside the
					 * <label>, and an anchor in there would toggle the input on
					 * click.
					 */}
					<p className="text-xs text-fog">
						Create one at{" "}
						<a
							href="https://dashboard.stripe.com/apikeys"
							target="_blank"
							rel="noreferrer noopener"
							className="text-mint hover:underline"
						>
							dashboard.stripe.com/apikeys
						</a>{" "}
						→ <strong className="text-[#e9efed]">Create restricted key</strong>, then:
					</p>
					<ol className="ml-4 list-decimal space-y-1 text-xs text-fog marker:text-fog/60">
						<li>
							Asked how you&rsquo;ll use it, choose{" "}
							<strong className="text-[#e9efed]">Providing this key to a third-party application</strong>.
						</li>
						<li>
							On the templates screen, ignore all of them and click{" "}
							<strong className="text-[#e9efed]">Choose your own</strong> — every template grants
							30&ndash;40 permissions and we need two.
						</li>
						<li>
							Set <strong className="text-[#e9efed]">Customers: Read</strong> and{" "}
							<strong className="text-[#e9efed]">Subscriptions: Read</strong>. Leave everything
							else, and the whole Connect column, on None.
						</li>
					</ol>
					<p className="text-xs text-fog/70">
						We only accept restricted keys. A standard secret key (<code>sk_…</code>) can refund
						your customers, and nothing here needs that.
					</p>
					<div>
						<Button type="button" onClick={connect} disabled={!key.trim() || busy === "connect"}>
							{busy === "connect" ? "Connecting…" : "Connect Stripe"}
						</Button>
					</div>
				</div>
			) : (
				<div className="grid gap-4">
					<dl className="grid gap-3 sm:grid-cols-3">
						<div>
							<dt className="text-[11px] tracking-widest text-fog uppercase">Key</dt>
							<dd className="mt-1 font-mono text-sm text-[#e9efed]">…{current.last4}</dd>
						</div>
						<div>
							<dt className="text-[11px] tracking-widest text-fog uppercase">Connected</dt>
							<dd className="mt-1 text-sm text-[#e9efed]">{shortDate(current.connectedAt)}</dd>
						</div>
						<div>
							<dt className="text-[11px] tracking-widest text-fog uppercase">Last sync</dt>
							<dd className="mt-1 text-sm text-[#e9efed]">
								{current.lastSyncedAt ? shortDate(current.lastSyncedAt) : "never"}
							</dd>
						</div>
					</dl>

					{/* Loud, not a quiet badge: a test key syncs and reports real
					    counts while storing nothing, so silence here would let a
					    vendor believe their proofs are payment-backed. */}
					{!current.livemode && (
						<p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
							<strong className="font-semibold">This is a test-mode key.</strong> Syncs run and
							report what they find, but nothing is published as evidence — test payments
							aren&rsquo;t evidence of anything. Connect a live restricted key to earn tier 3.
						</p>
					)}

					{current.lastSyncError && (
						<p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
							<strong className="font-semibold">Last sync failed:</strong> {current.lastSyncError}
						</p>
					)}

					{summary && (
						<div className="rounded-lg border border-edge bg-ink/40 px-4 py-3 text-sm">
							<p className="text-[#e9efed]">
								<span className="text-mint">{summary.matched}</span>{" "}
								{summary.matched === 1 ? "customer" : "customers"} matched to observed usage
								{summary.unmatched > 0 && (
									<>
										{" · "}
										<span className="text-amber-200">{summary.unmatched}</span> couldn&rsquo;t be
										matched
									</>
								)}
							</p>
							{summary.unmatched > 0 && (
								<p className="mt-1 text-xs text-fog">
									Unmatched payments are usually billing through a parent company, a
									procurement address, or a company we haven&rsquo;t observed using your
									product yet. They&rsquo;re never published as evidence.
								</p>
							)}
							{summary.testMode && (
								<p className="mt-1 text-xs text-amber-200/80">
									Nothing was stored — this key is in test mode.
								</p>
							)}
							{summary.truncated && (
								<p className="mt-1 text-xs text-fog">
									You have more subscriptions than one sync reads; counts above are partial.
								</p>
							)}
						</div>
					)}

					<div className="flex flex-wrap items-center gap-3">
						<Button type="button" variant="secondary" onClick={sync} disabled={busy === "sync"}>
							{busy === "sync" ? "Syncing…" : "Sync now"}
						</Button>
						<button
							type="button"
							onClick={disconnect}
							disabled={busy === "disconnect"}
							className="text-xs text-fog transition hover:text-red-300"
						>
							{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
						</button>
					</div>
				</div>
			)}
		</Card>
	);
}
