import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { currentVendor } from "@/lib/vendors/session";
import { updateCustomer, deleteCustomer } from "@/lib/vendors/customers";

/**
 * PATCH /api/vendor/customers/{slug} — update name/domain/since/consent/features
 * on one of the signed-in vendor's own customers.
 *
 * Matched by (vendor_id, slug), never by id alone — RLS's "vendor members can
 * manage their own customers" policy already restricts this to the caller's
 * own vendor_id, so this is a plain scoped update, not a second manual
 * ownership check. A match on zero rows reads as 404 — that covers both "no
 * such customer" and "not yours", which is the correct conflation (see
 * feedback_rls_trust_pattern): nothing here distinguishes the two on purpose.
 *
 * Validation and the domain gate live in src/lib/vendors/customers.ts, shared
 * with the bearer-token tool dispatcher (src/lib/tools/registry.ts).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const { slug } = await params;
	const body = await request.json().catch(() => null);
	if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

	const supabase = await createServerSupabaseClient();
	const result = await updateCustomer(supabase, vendor.id, slug, body);
	if (!result.ok) return NextResponse.json(result.body, { status: result.status });

	return NextResponse.json({ customer: result.data });
}

/** DELETE /api/vendor/customers/{slug} — same trust-RLS, 404-on-empty pattern as PATCH. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const { slug } = await params;
	const supabase = await createServerSupabaseClient();
	const result = await deleteCustomer(supabase, vendor.id, slug);
	if (!result.ok) return NextResponse.json(result.body, { status: result.status });

	return new NextResponse(null, { status: 204 });
}
