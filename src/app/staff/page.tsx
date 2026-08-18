import Link from "next/link";
import { getUser } from "@/lib/auth/server";
import { collectionHealth, type CollectionStatus, type VendorHealth } from "@/lib/staff/health";
import { SignOutButton } from "./SignOutButton";

// getUser() reads the request's cookies, so this route can't be statically
// prerendered — without this, Next bakes one build-time (signed-out) render
// and serves it to everyone (see the same fix on `/` and `/vendor/*`).
export const dynamic = "force-dynamic";

/**
 * Staff overview — is collection working?
 *
 * The first thing worth knowing on opening this area, because it is the thing
 * that has silently broken twice: once when attest.js pointed at a dead alias
 * for 65 hours, once when a missing migration made the collector reject every
 * event. Both times the only symptom was a table that stopped growing.
 *
 * Deliberately shows the shape rather than a verdict. A quiet weekend and a
 * broken install produce the same low number, so the judgement stays with the
 * person reading it — the automated check that CAN tell them apart probes the
 * script URL directly, and lives in the lettertrace repo where the install is.
 */

const STATUS_LABEL: Record<CollectionStatus, string> = {
	reporting: "reporting",
	silent: "silent",
	never: "never reported",
};

function statusTone(status: CollectionStatus): string {
	if (status === "reporting") return "border-mint/30 bg-mint/10 text-mint";
	if (status === "silent") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
	return "border-edge text-fog";
}

/** "3h ago" / "6d ago" — a duration is what you actually read here, not a timestamp. */
function ago(hours: number | null): string {
	if (hours === null) return "never";
	if (hours < 1) return `${Math.round(hours * 60)}m ago`;
	if (hours < 48) return `${Math.round(hours)}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

export default async function StaffHome() {
	const user = await getUser();
	if (!user) return null;

	const health = await collectionHealth();

	return (
		<main className="mx-auto max-w-5xl px-6 py-12">
			<div className="flex items-baseline justify-between gap-4">
				<div>
					<p className="font-mono text-sm text-mint">staff</p>
					<h1 className="mt-2 text-3xl font-semibold tracking-tight">Collection</h1>
				</div>
				<div className="flex items-center gap-4 text-sm">
					<Link href="/staff/tiers" className="text-fog hover:text-mint">
						verification tiers →
					</Link>
					<SignOutButton />
				</div>
			</div>
			<p className="mt-3 max-w-2xl text-fog">
				Whether anything is arriving, per vendor. Signed in as {user.email}.
			</p>

			{health === null ? (
				/* Not the same as "nothing arrived" — one of those is an outage. */
				<p className="mt-8 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
					No datastore configured, so collection cannot be read at all. This is a configuration
					state, not an absence of events.
				</p>
			) : health.length === 0 ? (
				<p className="mt-8 text-sm text-fog">No vendors on record.</p>
			) : (
				<div className="mt-8 overflow-x-auto rounded-lg border border-edge">
					<table className="w-full text-left text-sm">
						<thead className="bg-panel text-fog">
							<tr>
								<th className="px-4 py-3 font-medium">Vendor</th>
								<th className="px-4 py-3 font-medium">Last event</th>
								<th className="px-4 py-3 font-medium">24h</th>
								<th className="px-4 py-3 font-medium">7d</th>
								<th className="px-4 py-3 font-medium">30d</th>
								<th className="px-4 py-3 font-medium">Customers</th>
								<th className="px-4 py-3 font-medium">Status</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-edge">
							{health.map((v) => (
								<Row key={v.vendor} v={v} />
							))}
						</tbody>
					</table>
				</div>
			)}

			<p className="mt-4 text-sm text-fog">
				&ldquo;Silent&rdquo; means a vendor reported before and has not in 24 hours. It is a
				prompt to look, not a verdict — a quiet weekend produces the same number as a broken
				install, which is why the automated check probes the script URL instead of the volume.
			</p>
		</main>
	);
}

function Row({ v }: { v: VendorHealth }) {
	return (
		<tr>
			<td className="px-4 py-3">
				<span className="font-medium">{v.vendor}</span>
				<span className="ml-2 font-mono text-xs text-fog">{v.domain}</span>
			</td>
			<td className="px-4 py-3 text-fog">{ago(v.hoursSinceLastEvent)}</td>
			<td className="px-4 py-3 tabular-nums">{v.events24h || <span className="text-fog/40">—</span>}</td>
			<td className="px-4 py-3 tabular-nums">{v.events7d || <span className="text-fog/40">—</span>}</td>
			<td className="px-4 py-3 tabular-nums">{v.events30d || <span className="text-fog/40">—</span>}</td>
			<td className="px-4 py-3 tabular-nums text-fog">{v.customers}</td>
			<td className="px-4 py-3">
				<span className={`rounded-full border px-2.5 py-0.5 text-xs ${statusTone(v.status)}`}>
					{STATUS_LABEL[v.status]}
				</span>
			</td>
		</tr>
	);
}
