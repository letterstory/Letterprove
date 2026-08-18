import Link from "next/link";
import { getUser } from "@/lib/auth/server";
import { vendorRoster, type VendorRow } from "@/lib/staff/vendors";

// getUser() reads the request's cookies, so this route can't be statically
// prerendered — the same reason /staff and /vendor/* carry it.
export const dynamic = "force-dynamic";

/**
 * Who is on the platform.
 *
 * The view you want first when a vendor emails: who they are, who owns the
 * account, which key they are installed with, and whether any of it publishes.
 * Collection health answers "is anything arriving" and the tier report answers
 * "why is this domain not a claim" — neither answers "who is this".
 *
 * Shows customer domains and account emails, so it lives behind the same
 * middleware wall as the rest of /staff, and getUser() re-checks rather than
 * assuming it held.
 */
export default async function StaffVendorsPage() {
	const user = await getUser();
	if (!user) return null;

	const roster = await vendorRoster();

	return (
		<main className="mx-auto max-w-5xl px-6 py-12">
			<div className="flex items-baseline justify-between gap-4">
				<div>
					<p className="font-mono text-sm text-mint">staff</p>
					<h1 className="mt-2 text-3xl font-semibold tracking-tight">Vendors</h1>
				</div>
				<nav className="flex items-center gap-4 text-sm text-fog">
					<Link href="/staff" className="hover:text-mint">
						collection
					</Link>
					<Link href="/staff/tiers" className="hover:text-mint">
						tiers
					</Link>
				</nav>
			</div>
			<p className="mt-3 max-w-2xl text-fog">
				Who is on the platform, who owns each account, and what each one publishes today.
			</p>

			{roster === null ? (
				<p className="mt-8 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
					No datastore configured, so the roster cannot be read. That is a configuration state,
					not an empty platform.
				</p>
			) : roster.length === 0 ? (
				<p className="mt-8 text-sm text-fog">No vendors yet.</p>
			) : (
				<div className="mt-8 space-y-4">
					{roster.map((v) => (
						<VendorCard key={v.slug} v={v} />
					))}
				</div>
			)}
		</main>
	);
}

function VendorCard({ v }: { v: VendorRow }) {
	return (
		<section className="rounded-lg border border-edge bg-panel p-5">
			<div className="flex flex-wrap items-baseline justify-between gap-3">
				<div>
					<h2 className="text-lg font-medium">{v.name}</h2>
					<p className="mt-0.5 text-sm text-fog">
						<span className="font-mono">{v.domain}</span> · {v.category}
					</p>
				</div>
				<Link href={`/proofs/${v.slug}`} className="font-mono text-xs text-fog hover:text-mint">
					/proofs/{v.slug} →
				</Link>
			</div>

			<dl className="mt-4 grid gap-4 sm:grid-cols-3">
				<Field label="Publishes">
					{/* Null is "could not read telemetry", which is not the same as
					    publishing nothing — saying "0 companies" for a failed read
					    would be a wrong answer rather than a missing one. */}
					{v.aggregate === null ? (
						<span className="text-amber-200">telemetry unreadable</span>
					) : v.aggregate.companies === 0 ? (
						<span className="text-fog">nothing yet</span>
					) : (
						<>
							{v.aggregate.companies} companies · {v.aggregate.sessions} sessions
							<span className="ml-2 text-fog">tier {v.aggregate.tier}</span>
						</>
					)}
				</Field>

				<Field label="Customers on record">
					{v.customers.total === 0 ? (
						<span className="text-fog">none</span>
					) : (
						<>
							{v.customers.total}
							<span className="ml-2 text-fog">
								{v.customers.named} named, {v.customers.total - v.customers.named} withheld
							</span>
						</>
					)}
				</Field>

				<Field label="Account">
					{v.members.length === 0 ? (
						// Seeded rather than self-signed-up — worth distinguishing, since
						// there is nobody to email.
						<span className="text-fog">no members (seeded)</span>
					) : (
						v.members.map((m) => (
							<div key={m.email} className="truncate">
								{m.email}
								{m.role !== "owner" && <span className="ml-2 text-fog">{m.role}</span>}
							</div>
						))
					)}
				</Field>
			</dl>

			{/* Public by design — it ships in the HTML of every authenticated page on
			    the vendor's site. Masking it would imply a secrecy it does not have. */}
			<p className="mt-4 border-t border-edge pt-3 font-mono text-xs text-fog">
				key <span className="text-fog/70">{v.key}</span>
			</p>
		</section>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<dt className="text-xs tracking-wider text-fog uppercase">{label}</dt>
			<dd className="mt-1 text-sm tabular-nums">{children}</dd>
		</div>
	);
}
