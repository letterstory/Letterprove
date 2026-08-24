import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { currentVendor } from "@/lib/vendors/session";
import { FEATURES } from "@/lib/fixtures/vendors";
import { listCustomers } from "@/lib/vendors/customers";
import { CustomersManager, type CustomerRow } from "./CustomersManager";
import { PageHeader } from "@/components/ui";

// Reads the signed-in vendor's session and customer rows per request;
// without this it gets prerendered once at build time with no vendor, same
// bug caught on the homepage (see src/app/page.tsx).
export const dynamic = "force-dynamic";

/**
 * Self-service CRUD over the signed-in vendor's `vendor_customers` rows —
 * identity (name/domain/since) and consent. Fetches directly through the
 * session-bound client rather than calling GET /api/vendor/customers from
 * here (that would be a same-process network hop for no reason); the API
 * route exists for the client-side add/edit/delete calls in
 * CustomersManager, and shares the same "trust RLS, scope by vendor_id"
 * query shape as this page.
 */
export default async function VendorCustomersPage() {
	const vendor = await currentVendor();
	if (!vendor) redirect("/vendor/login");

	const supabase = await createServerSupabaseClient();
	// Through listCustomers() rather than a hand-written select. This page used
	// to repeat the column list, and it silently drifted: `consent_sent_to`
	// shipped, listCustomers() knew about it, this query didn't, so the row
	// always arrived with the field undefined and the button could never read
	// "Resend request" — a vendor had no way to see a request was already out.
	// One source of truth for the columns means that can't recur.
	const result = await listCustomers(supabase, vendor.id);
	const customers = (result.ok ? result.data : []) as CustomerRow[];

	return (
		<>
			<PageHeader
				title="Your customers"
				aside={
					<a
						href={`/proofs/${vendor.slug}`}
						className="rounded border border-edge px-3 py-1.5 text-sm text-fog transition hover:border-mint hover:text-mint"
					>
						View public page ↗
					</a>
				}
			>
				The customers you attest to on your public proof page. New customers start{" "}
				<strong className="text-[#e9efed]">anonymous</strong>&nbsp;— switch one to
				&ldquo;named&rdquo; only once they&rsquo;ve actually agreed to be identified publicly.
			</PageHeader>

			<div className="mt-8">
				<CustomersManager initialCustomers={customers} features={FEATURES} />
			</div>
		</>
	);
}
