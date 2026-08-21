"use client";

import { useMemo, useState } from "react";
import type { DomainTierRow, TierStatus, VendorTierReport } from "@/lib/tiers/report";
import { PromoteButton } from "./PromoteButton";
import { eventsOf, isActionable, matchesQuery, sortRows, STATUS_LABEL } from "./filter";

/**
 * The interactive half of /staff/tiers. The page itself stays a server
 * component so the report is still fetched on the server; everything here is
 * filtering and disclosure over data that has already arrived.
 *
 * Built around the question the page exists to answer — "what do I need to do
 * something about" — rather than "show me everything". A vendor with 49
 * observed domains is mostly noise: free-mail and internal domains can never
 * be published, so they are permanent rows that will never change and never
 * need action. They used to sit at the top purely because the report returned
 * them first.
 */

/** Mint for a live claim, amber for something a person can act on, grey for the rest. */
function statusTone(status: TierStatus): string {
	if (status === "published") return "border-mint/30 bg-mint/10 text-mint";
	if (status === "no-customer-record") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
	if (status === "consent-withheld") return "border-amber-500/20 bg-amber-500/5 text-amber-200/80";
	return "border-edge text-fog";
}

type Lens = "actionable" | "all";

/** How many rows a vendor shows before "Show N more". Roughly one screen. */
const ROW_CAP = 12;

export function TiersExplorer({ reports }: { reports: VendorTierReport[] }) {
	const [query, setQuery] = useState("");
	const [lens, setLens] = useState<Lens>("actionable");
	// Which vendors the user has explicitly toggled away from the default.
	// Stored as a diff rather than a full open-set so the sensible default
	// (open when there's work, closed when there isn't) keeps applying to
	// vendors the user has never touched.
	const [toggled, setToggled] = useState<Set<string>>(() => new Set());

	const q = query.trim().toLowerCase();

	const filtered = useMemo(() => {
		return reports.map((report) => {
			const rows = sortRows(report.rows).filter(
				(row) =>
					(lens === "all" || isActionable(row.status)) && matchesQuery(row, q),
			);
			// A vendor matched by name keeps all of its (lens-filtered) rows, so
			// searching "lettertrace" reads as "show me this vendor" rather than
			// returning nothing because no domain contains the vendor's name.
			const nameMatch = q.length > 0 && report.vendor.toLowerCase().includes(q);
			const lensRows = sortRows(report.rows).filter(
				(row) => lens === "all" || isActionable(row.status),
			);
			return { report, rows: nameMatch ? lensRows : rows, nameMatch };
		});
	}, [reports, q, lens]);

	const visible = filtered.filter((f) => f.rows.length > 0 || (!q && lens === "all"));
	const totalShown = filtered.reduce((n, f) => n + f.rows.length, 0);
	const totalRows = reports.reduce((n, r) => n + r.rows.length, 0);
	const totalActionable = reports.reduce(
		(n, r) => n + r.rows.filter((row) => isActionable(row.status)).length,
		0,
	);

	function isOpen(report: VendorTierReport, rowCount: number): boolean {
		// While searching, anything still on screen is a hit — collapsing hits
		// would hide the thing the search just found.
		if (q) return true;
		const byDefault = rowCount > 0 && report.unpublishedEvidence > 0;
		return toggled.has(report.vendor) ? !byDefault : byDefault;
	}

	function toggle(vendor: string) {
		setToggled((prev) => {
			const next = new Set(prev);
			if (next.has(vendor)) next.delete(vendor);
			else next.add(vendor);
			return next;
		});
	}

	return (
		<div className="mt-8">
			<div className="flex flex-wrap items-center gap-3">
				<div className="relative min-w-[16rem] flex-1">
					<input
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search domain, customer, or vendor…"
						aria-label="Search domains"
						className="w-full rounded-lg border border-edge bg-panel py-2 pr-9 pl-3 text-sm text-[#e9efed] outline-none transition placeholder:text-fog/60 focus:border-mint"
					/>
					{query && (
						<button
							type="button"
							onClick={() => setQuery("")}
							aria-label="Clear search"
							className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-1.5 text-fog transition hover:text-mint"
						>
							✕
						</button>
					)}
				</div>

				<div className="flex overflow-hidden rounded-lg border border-edge" role="group" aria-label="Filter rows">
					<LensButton active={lens === "actionable"} onClick={() => setLens("actionable")}>
						Needs action{totalActionable > 0 && <Count>{totalActionable}</Count>}
					</LensButton>
					<LensButton active={lens === "all"} onClick={() => setLens("all")}>
						All domains<Count>{totalRows}</Count>
					</LensButton>
				</div>
			</div>

			<p className="mt-3 text-xs text-fog">
				{totalShown === 0
					? "No domains match."
					: `Showing ${totalShown} of ${totalRows} domain${totalRows === 1 ? "" : "s"}`}
				{lens === "actionable" && !q && totalActionable === 0 && totalRows > 0 && (
					<> — nothing is waiting on a record or consent right now.</>
				)}
			</p>

			{visible.length === 0 && (
				<p className="mt-8 rounded-lg border border-dashed border-edge px-6 py-10 text-center text-sm text-fog">
					{q ? (
						<>
							Nothing matches <span className="font-mono text-[#e9efed]">{query}</span>
							{lens === "actionable" && " in domains that need action."}
						</>
					) : (
						"Nothing to act on."
					)}
				</p>
			)}

			{visible.map(({ report, rows }) => (
				<VendorSection
					key={report.vendor}
					report={report}
					rows={rows}
					open={isOpen(report, rows.length)}
					onToggle={() => toggle(report.vendor)}
					searching={q.length > 0}
				/>
			))}
		</div>
	);
}

function LensButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`px-3 py-2 text-sm whitespace-nowrap transition ${
				active ? "bg-mint/10 text-mint" : "bg-panel text-fog hover:text-[#e9efed]"
			}`}
		>
			{children}
		</button>
	);
}

function Count({ children }: { children: React.ReactNode }) {
	return <span className="ml-1.5 font-mono text-xs opacity-60">{children}</span>;
}

function VendorSection({
	report,
	rows,
	open,
	onToggle,
	searching,
}: {
	report: VendorTierReport;
	rows: DomainTierRow[];
	open: boolean;
	onToggle: () => void;
	searching: boolean;
}) {
	const actionable = rows.filter((r) => isActionable(r.status)).length;
	const promotable = rows.filter((r) => r.status === "no-customer-record").length;

	// Reset to the capped view whenever the visible set changes, so clearing a
	// search doesn't leave 45 rows expanded from a previous query.
	const [expanded, setExpanded] = useState(false);
	const cap = expanded || searching ? rows.length : ROW_CAP;
	const shown = rows.slice(0, cap);
	const hidden = rows.length - shown.length;

	return (
		<section className="mt-6 overflow-hidden rounded-lg border border-edge">
			<button
				type="button"
				onClick={onToggle}
				disabled={searching}
				aria-expanded={open}
				className="flex w-full items-center gap-3 bg-panel px-4 py-3 text-left transition hover:bg-ink/40 disabled:cursor-default disabled:hover:bg-panel"
			>
				<span
					className={`text-fog transition-transform duration-200 ${open ? "rotate-90" : ""}`}
					aria-hidden="true"
				>
					›
				</span>
				<h2 className="text-sm font-semibold tracking-widest text-[#e9efed] uppercase">
					{report.vendor}
				</h2>

				{/* A collapsed section still has to inform, or collapsing just hides
				    the page instead of tidying it. */}
				<span className="ml-auto flex items-center gap-4 text-xs text-fog">
					<Pair label="observed" value={report.observed} />
					<Pair label="published" value={report.published} />
					{actionable > 0 && (
						<span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-amber-200">
							{actionable} to action
						</span>
					)}
				</span>
			</button>

			{open && (
				<div className="border-t border-edge">
					<dl className="grid grid-cols-2 gap-px bg-edge sm:grid-cols-4">
						<Tile label="Domains observed" value={report.observed} />
						<Tile label="Attributable" value={report.attributable} />
						<Tile
							label="Awaiting a record or consent"
							value={report.unpublishedEvidence}
							amber={report.unpublishedEvidence > 0}
						/>
						<Tile label="Published" value={report.published} />
					</dl>

					{rows.length === 0 ? (
						<p className="px-4 py-6 text-sm text-fog">
							Nothing observed and no customers on record.
						</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-left text-sm">
								<thead className="bg-ink/40 text-fog">
									<tr>
										<Th>Domain</Th>
										<Th className="text-right">Events</Th>
										<Th>Tier</Th>
										<Th>Status</Th>
										<Th>Why</Th>
										<Th className="text-right">{""}</Th>
									</tr>
								</thead>
								<tbody className="divide-y divide-edge/60">
									{shown.map((row) => (
										<Row key={row.domain} row={row} vendor={report.vendor} />
									))}
								</tbody>
							</table>

							{/* 45 actionable domains is a real backlog, but rendering all of
							    them at once is what turned this into a page nobody scrolls
							    to the bottom of. The rest are one click away, and search
							    reaches them without expanding. */}
							{hidden > 0 && (
								<button
									type="button"
									onClick={() => setExpanded(true)}
									className="w-full border-t border-edge bg-panel px-4 py-2.5 text-sm text-fog transition hover:bg-ink/40 hover:text-mint"
								>
									Show {hidden} more {hidden === 1 ? "domain" : "domains"}
								</button>
							)}

							{promotable > 0 && (
								<p className="border-t border-edge px-4 py-2.5 text-xs text-fog/70">
									“Record as customer” creates an anonymous record — counted in the aggregate,
									not named publicly.
								</p>
							)}
						</div>
					)}
				</div>
			)}
		</section>
	);
}

function Pair({ label, value }: { label: string; value: number }) {
	return (
		<span className="hidden sm:inline">
			<span className="tabular-nums text-[#e9efed]">{value}</span>{" "}
			<span className="text-fog/70">{label}</span>
		</span>
	);
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
	return (
		<th
			className={`px-4 py-2.5 text-[11px] font-semibold tracking-widest whitespace-nowrap uppercase ${className}`}
		>
			{children}
		</th>
	);
}

function Row({ row, vendor }: { row: DomainTierRow; vendor: string }) {
	const events = eventsOf(row);

	return (
		<tr className="align-top transition-colors hover:bg-ink/30">
			<td className="px-4 py-3">
				<span className="font-mono text-[13px] text-[#e9efed]">{row.domain}</span>
				{row.customer && <span className="ml-2 text-xs text-fog">· {row.customer}</span>}
			</td>
			<td className="px-4 py-3 text-right whitespace-nowrap tabular-nums text-fog">
				{events === 0 ? (
					<span className="text-fog/40">—</span>
				) : (
					<>
						<span className="text-[#e9efed]">{events}</span>
						<span className="ml-2 font-mono text-xs text-fog/70">
							{row.sessions}s {row.signups}u {row.logins}l
						</span>
					</>
				)}
			</td>
			<td className="px-4 py-3 whitespace-nowrap tabular-nums">
				{/* Asserted and earned side by side: "what does the vendor claim" is
				    almost always the next question, and a bare earned tier hides
				    whether the gate did anything. */}
				{row.assertedTier === null ? (
					<span className="text-fog/40">—</span>
				) : row.earnedTier === row.assertedTier ? (
					<span>{row.earnedTier}</span>
				) : (
					<span className="text-fog">
						<span className="text-amber-200">{row.earnedTier}</span> of {row.assertedTier}
					</span>
				)}
			</td>
			<td className="px-4 py-3">
				<span
					className={`inline-block rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap ${statusTone(row.status)}`}
				>
					{STATUS_LABEL[row.status]}
				</span>
			</td>
			<td className="max-w-md px-4 py-3 text-fog">{row.detail}</td>
			{/* The only row anyone can act on from here. Everything else needs a
			    decision made outside this system — consent from the customer, or
			    an install that produces evidence. The caption that used to sit
			    under every button now sits once, under the table: 45 identical
			    copies of it was most of what made this page unreadable. */}
			<td className="px-4 py-3 text-right">
				{row.status === "no-customer-record" && (
					<PromoteButton vendor={vendor} domain={row.domain} />
				)}
			</td>
		</tr>
	);
}

function Tile({ label, value, amber = false }: { label: string; value: number; amber?: boolean }) {
	return (
		<div className="bg-panel px-4 py-4">
			<dt className="text-[11px] tracking-wider text-fog uppercase">{label}</dt>
			<dd className={`mt-1 text-xl font-semibold tabular-nums ${amber ? "text-amber-200" : ""}`}>
				{value}
			</dd>
		</div>
	);
}
