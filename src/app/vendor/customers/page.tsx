import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { currentVendor } from "@/lib/vendors/session";
import { FEATURES } from "@/lib/fixtures/vendors";
import { CustomersManager, type CustomerRow } from "./CustomersManager";

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
	const { data } = await supabase
		.from("vendor_customers")
		.select("id, slug, name, domain, since, tier, verified, features, consent")
		.eq("vendor_id", vendor.id)
		.order("created_at", { ascending: true });

	const customers = (data ?? []) as CustomerRow[];

	return (
		<>
			<h1 className="text-2xl font-semibold tracking-tight">Your customers</h1>
			<p className="mt-3 max-w-2xl text-fog">
				The customers you attest to on your{" "}
				<a href={`/proofs/${vendor.slug}`} className="text-mint hover:underline">
					public proof page
				</a>
				. New customers start <strong>anonymous</strong> — switch one to &ldquo;named&rdquo; only
				once they&rsquo;ve actually agreed to be identified publicly.
			</p>

			<div className="mt-8">
				<CustomersManager initialCustomers={customers} features={FEATURES} />
			</div>
		</>
	);
}
