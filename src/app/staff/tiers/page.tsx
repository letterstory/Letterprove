import { getUser } from "@/lib/auth/server";
import { vendorSlugs } from "@/lib/attest/proofs";
import { tierReport, type VendorTierReport } from "@/lib/tiers/report";
import { TiersExplorer } from "./TiersExplorer";

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
 *
 * The fetch stays here, on the server. Search and disclosure live in
 * TiersExplorer, a client component, so filtering never costs a round trip and
 * the report is never shipped twice.
 */
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

			<TiersExplorer reports={vendors} />
		</>
	);
}
