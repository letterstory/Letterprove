import { PageHeader } from "@/components/ui";
import { currentVendor } from "@/lib/vendors/session";
import { tierReport } from "@/lib/tiers/report";
import { ObservedManager } from "./ObservedManager";

// Reads the session and queries telemetry — same reason every /vendor page
// carries it.
export const dynamic = "force-dynamic";

/**
 * The half of the core loop that used to live only under /staff.
 *
 * A vendor could install the script, generate real evidence from dozens of
 * companies, and have no way to see any of it — the observed-domain report and
 * the promote action were both staff-only, so their proof page read zero until
 * somebody at Letterstory acted on their behalf. /privacy §4 already told them
 * this view existed in "the vendor's own dashboard"; now it does.
 */
export default async function ObservedPage() {
	const vendor = await currentVendor();
	if (!vendor) return null;

	const report = await tierReport(vendor.slug);

	return (
		<div className="grid gap-8">
			<PageHeader title="Companies observed">
				Every company we&rsquo;ve seen using {vendor.name}, and whether it counts toward your
				published proof yet.
			</PageHeader>

			{/* A failed read is NOT "nothing observed" — saying so would tell a
			    vendor their install is broken when it may be fine. */}
			{!report ? (
				<p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
					We couldn&rsquo;t read your telemetry just now. This is a failed read on our side, not
					an absence of activity — try again shortly.
				</p>
			) : (
				<ObservedManager
					summary={{
						observed: report.observed,
						attributable: report.attributable,
						awaiting: report.unpublishedEvidence,
						published: report.published,
					}}
					initialDomains={report.rows.map((row) => ({
						domain: row.domain,
						kind: row.kind,
						events: row.sessions + row.signups + row.logins,
						sessions: row.sessions,
						signups: row.signups,
						logins: row.logins,
						customer: row.customer,
						status: row.status,
						detail: row.detail,
					}))}
				/>
			)}
		</div>
	);
}
