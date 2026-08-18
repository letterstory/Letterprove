import { getUser } from "@/lib/auth/server";
import { vendorSlugs } from "@/lib/attest/proofs";
import { tierReport, type DomainTierRow, type TierStatus, type VendorTierReport } from "@/lib/tiers/report";
import { PromoteButton } from "./PromoteButton";

// getUser() reads the request's cookies, so this can't be statically
// prerendered — the same reason /staff and /vendor/* carry it.
export const dynamic = "force-dynamic";

/**
 * Why every claim sits at the tier it does.
 *
 * The question this answers — "how are the tiers looking" — was until now
 * answered by hand: a Supabase query, a customer-record read, and a mental
 * join. Every number here is derived, nothing is signed, and nothing published
 * changes because someone opened this page.
 *
 * It deliberately shows customer domains, including ones withheld for consent
 * and ones that can never be attributed. That is the whole point of a staff
 * view, and it is also why this must never be reachable signed-out —
 * middleware gates /staff/*, and getUser() below re-checks rather than
 * assuming it did.
 */

const STATUS_LABEL: Record<TierStatus, string> = {
	published: "published",
	"consent-withheld": "awaiting consent",
	"no-customer-record": "no customer record",
	"no-observation": "no evidence",
	"not-attributable": "not attributable",
};

/** Mint for a live claim, amber for something a person can act on, grey for the rest. */
function statusTone(status: TierStatus): string {
	if (status === "published") return "border-mint/30 bg-mint/10 text-mint";
	if (status === "no-customer-record") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
	return "border-edge text-fog";
}

export default async function StaffTiersPage() {
	if (!(await getUser())) return null;

	const slugs = await vendorSlugs();
	const reports = await Promise.all(slugs.map((s) => tierReport(s)));
	const unreadable = slugs.filter((_, i) => reports[i] === null);
	const vendors = reports.filter((r): r is VendorTierReport => r !== null);

	return (
		<>
			<h1 className="text-3xl font-semibold tracking-tight">Verification tiers</h1>
			<p className="mt-3 max-w-2xl text-fog">
				What has been observed, who is on record, and the one thing stopping each domain from
				being a published claim.
			</p>

			{/* A vendor whose telemetry could not be read is NAMED, never dropped. An
			    absent vendor reads as "nothing observed", which is exactly the wrong
			    conclusion to act on. */}
			{unreadable.length > 0 && (
				<p className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
					Could not read telemetry for <strong>{unreadable.join(", ")}</strong>. These are not
					shown below — that is a failed read, not an absence of evidence.
				</p>
			)}

			{vendors.map((v) => (
				<VendorSection key={v.vendor} report={v} />
			))}
		</>
	);
}

function VendorSection({ report }: { report: VendorTierReport }) {
	return (
		<section className="mt-12">
			<h2 className="text-sm font-semibold tracking-widest text-fog uppercase">{report.vendor}</h2>

			<dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-edge bg-edge sm:grid-cols-4">
				<Tile label="Domains observed" value={report.observed} />
				<Tile label="Attributable" value={report.attributable} />
				<Tile label="Awaiting a record or consent" value={report.unpublishedEvidence} amber={report.unpublishedEvidence > 0} />
				<Tile label="Published" value={report.published} />
			</dl>

			{report.rows.length === 0 ? (
				<p className="mt-4 text-sm text-fog">Nothing observed and no customers on record.</p>
			) : (
				<div className="mt-4 overflow-x-auto rounded-lg border border-edge">
					<table className="w-full text-left text-sm">
						<thead className="bg-panel text-fog">
							<tr>
								<th className="px-4 py-3 font-medium">Domain</th>
								<th className="px-4 py-3 font-medium">Events</th>
								<th className="px-4 py-3 font-medium">Tier</th>
								<th className="px-4 py-3 font-medium">Status</th>
								<th className="px-4 py-3 font-medium">Why</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-edge">
							{report.rows.map((row) => (
								<Row key={row.domain} row={row} vendor={report.vendor} />
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

function Row({ row, vendor }: { row: DomainTierRow; vendor: string }) {
	const events = row.sessions + row.signups + row.logins;

	return (
		<tr>
			<td className="px-4 py-3">
				<span className="font-mono">{row.domain}</span>
				{row.customer && <span className="ml-2 text-xs text-fog">· {row.customer}</span>}
			</td>
			<td className="px-4 py-3 tabular-nums text-fog">
				{events === 0 ? "—" : events}
				{events > 0 && (
					<span className="ml-2 font-mono text-xs">
						{row.sessions}s {row.signups}u {row.logins}l
					</span>
				)}
			</td>
			<td className="px-4 py-3 tabular-nums">
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
				<span className={`rounded-full border px-2.5 py-0.5 text-xs ${statusTone(row.status)}`}>
					{STATUS_LABEL[row.status]}
				</span>
			</td>
			<td className="px-4 py-3 text-fog">
				{row.detail}
				{/* The only row anyone can act on from here. Everything else needs a
				    decision made outside this system — consent from the customer,
				    or an install that produces evidence. */}
				{row.status === "no-customer-record" && (
					<div className="mt-2">
						<PromoteButton vendor={vendor} domain={row.domain} />
						<p className="mt-1 text-xs text-fog/70">
							Creates an anonymous record — counted in the aggregate, not named publicly.
						</p>
					</div>
				)}
			</td>
		</tr>
	);
}

function Tile({ label, value, amber = false }: { label: string; value: number; amber?: boolean }) {
	return (
		<div className="bg-panel px-4 py-5">
			<dt className="text-xs tracking-wider text-fog uppercase">{label}</dt>
			<dd className={`mt-1 text-xl font-semibold tabular-nums ${amber ? "text-amber-200" : ""}`}>
				{value}
			</dd>
		</div>
	);
}
