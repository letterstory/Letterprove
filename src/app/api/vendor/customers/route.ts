import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { currentVendor } from "@/lib/vendors/session";
import { listCustomers, createCustomer } from "@/lib/vendors/customers";

/** GET /api/vendor/customers — every customer row for the signed-in vendor. */
export async function GET() {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const supabase = await createServerSupabaseClient();
	const result = await listCustomers(supabase, vendor.id);
	if (!result.ok) return NextResponse.json(result.body, { status: result.status });

	return NextResponse.json({ customers: result.data });
}

/**
 * POST /api/vendor/customers — create one.
 *
 * `tier`, `verified`, and `features` are provenance signals this v0 doesn't
 * compute yet (tier/verified come from the attest pipeline; features are
 * proven, not asserted) — a vendor never sets these at creation, regardless
 * of what the request body contains.
 *
 * `consent` defaults to "anonymous" when omitted or anything other than the
 * literal string "named" — see src/lib/fixtures/vendors.ts's consentOf():
 * publishing a third party's identity without consent is the one failure
 * mode this product must never fall into by accident.
 *
 * Validation and the domain gate live in src/lib/vendors/customers.ts, shared
 * with the bearer-token tool dispatcher (src/lib/tools/registry.ts) — this
 * route only resolves the session and shapes the response.
 */
export async function POST(request: Request) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const body = await request.json().catch(() => null);
	if (!body) return NextResponse.json({ error: "slug, name, domain, and since are required" }, { status: 400 });

	const supabase = await createServerSupabaseClient();
	const result = await createCustomer(supabase, vendor.id, body);
	if (!result.ok) return NextResponse.json(result.body, { status: result.status });

	return NextResponse.json({ customer: result.data }, { status: 201 });
}
