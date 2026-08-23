"use client";

import { useMemo, useState } from "react";
import { Button, ErrorBanner } from "@/components/form";
import { Badge, Card, EmptyState, Stat, StatRow, Td, Th, TableWrap } from "@/components/ui";

export interface ObservedDomain {
	domain: string;
	kind: string;
	events: number;
	sessions: number;
	signups: number;
	logins: number;
	customer: string | null;
	status: string;
	detail: string;
}

export interface ObservedSummary {
	observed: number;
	attributable: number;
	awaiting: number;
	published: number;
}

/**
 * The companies observed using a vendor's product, and the one action they can
 * take about it.
 *
 * Ordering is the whole design. The report returns domains in its own order,
 * which puts the loudest first — and the loudest are consistently the ones
 * nothing can ever be done about, because free-mail domains carry far more
 * traffic than any single customer. Sorting by actionability instead means the
 * first row on the page is always the next thing worth clicking.
 */
const ACTIONABLE = "no-customer-record";

/** Rows shown before "Show N more". Roughly a screen — see /staff/tiers. */
const ROW_CAP = 15;

const STATUS_LABEL: Record<string, string> = {
	published: "published",
	"consent-withheld": "awaiting consent",
	"no-customer-record": "not recorded yet",
	"no-observation": "no evidence",
	"not-attributable": "can't be attributed",
};

function tone(status: string): "mint" | "warn" | "neutral" {
	if (status === "published") return "mint";
	if (status === ACTIONABLE || status === "consent-withheld") return "warn";
	return "neutral";
}

export function ObservedManager({
	summary,
	initialDomains,
}: {
	summary: ObservedSummary;
	initialDomains: ObservedDomain[];
}) {
	const [domains, setDomains] = useState(initialDomains);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [onlyActionable, setOnlyActionable] = useState(true);
	const [expanded, setExpanded] = useState(false);

	const sorted = useMemo(() => {
		const rank = (d: ObservedDomain) =>
			d.status === ACTIONABLE ? 0 : d.status === "consent-withheld" ? 1 : d.status === "published" ? 2 : 3;
		return [...domains].sort(
			(a, b) => rank(a) - rank(b) || b.events - a.events || a.domain.localeCompare(b.domain)
		);
	}, [domains]);

	const visible = onlyActionable ? sorted.filter((d) => d.status === ACTIONABLE) : sorted;
	// A long backlog is good news, but forty rows at once is a wall rather than
	// a worklist — the rest are one click away and already sorted by value.
	const shown = expanded ? visible : visible.slice(0, ROW_CAP);
	const hidden = visible.length - shown.length;
	const actionable = domains.filter((d) => d.status === ACTIONABLE).length;

	async function record(domain: string) {
		setBusy(domain);
		setError(null);
		try {
			const res = await fetch("/api/vendor/observed", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ domain }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setError(body?.error ?? `Couldn't record ${domain} (${res.status})`);
				return;
			}
			const { customer } = (await res.json()) as { customer: { slug: string } };
			// Reflect the new state locally rather than refetching: the row moves
			// out of "not recorded yet" and the counts above it follow.
			setDomains((prev) =>
				prev.map((d) =>
					d.domain === domain
						? { ...d, status: "consent-withheld", customer: customer.slug, detail: "recorded — counted in your totals, not named publicly" }
						: d
				)
			);
		} catch {
			setError("Couldn't reach the server.");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="grid gap-6">
			<StatRow>
				<Stat label="Companies observed" value={summary.observed} />
				<Stat label="Can be attributed" value={summary.attributable} />
				<Stat
					label="Not recorded yet"
					value={actionable}
					tone={actionable > 0 ? "mint" : "muted"}
					hint={actionable > 0 ? "these are one click from counting" : undefined}
				/>
				<Stat label="Published" value={summary.published} />
			</StatRow>

			{error && <ErrorBanner>{error}</ErrorBanner>}

			<Card
				title="Companies seen using your product"
				aside={
					<button
						type="button"
						onClick={() => setOnlyActionable((v) => !v)}
						className="text-xs text-fog normal-case transition hover:text-mint"
					>
						{onlyActionable ? `Show all ${domains.length}` : "Show only what needs action"}
					</button>
				}
			>
				<p className="-mt-1 mb-4 text-sm text-fog">
					Recording a company counts it in your published totals. It is{" "}
					<strong className="text-[#e9efed]">never named publicly</strong> until they agree to be
					— you send them a consent link from the Customers tab.
				</p>

				{shown.length === 0 ? (
					<EmptyState title={onlyActionable ? "Nothing waiting" : "Nothing observed yet"}>
						{onlyActionable
							? "Every company we've observed is already recorded."
							: "Once your install starts seeing traffic, the companies behind it appear here."}
					</EmptyState>
				) : (
					<TableWrap>
						<thead>
							<tr>
								<Th>Company domain</Th>
								<Th className="text-right">Activity</Th>
								<Th>Status</Th>
								<Th className="text-right">{""}</Th>
							</tr>
						</thead>
						<tbody>
							{shown.map((d) => (
								<tr key={d.domain} className="align-top transition-colors hover:bg-ink/30">
									<Td>
										<span className="font-mono text-[13px] text-[#e9efed]">{d.domain}</span>
										{d.customer && <span className="ml-2 text-xs text-fog">· {d.customer}</span>}
										<span className="mt-1 block text-xs text-fog/70">{d.detail}</span>
									</Td>
									<Td className="text-right whitespace-nowrap tabular-nums">
										{d.events === 0 ? (
											<span className="text-fog/40">—</span>
										) : (
											<>
												<span className="text-[#e9efed]">{d.events}</span>
												<span className="ml-2 font-mono text-xs text-fog/70">
													{d.sessions}s {d.signups}u {d.logins}l
												</span>
											</>
										)}
									</Td>
									<Td>
										<Badge tone={tone(d.status)}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
									</Td>
									<Td className="text-right">
										{d.status === ACTIONABLE && (
											<Button
												type="button"
												variant="secondary"
												disabled={busy === d.domain}
												onClick={() => record(d.domain)}
											>
												{busy === d.domain ? "Recording…" : "Record as customer"}
											</Button>
										)}
									</Td>
								</tr>
							))}
						</tbody>
					</TableWrap>
				)}

				{hidden > 0 && (
					<button
						type="button"
						onClick={() => setExpanded(true)}
						className="mt-3 w-full rounded-lg border border-edge py-2 text-sm text-fog normal-case transition hover:border-mint/40 hover:text-mint"
					>
						Show {hidden} more
					</button>
				)}
			</Card>
		</div>
	);
}
