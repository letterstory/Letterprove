import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { currentVendor } from "@/lib/vendors/session";
import type { Consent } from "@/lib/fixtures/vendors";

/** GET /api/vendor/customers — every customer row for the signed-in vendor. */
export async function GET() {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const supabase = await createServerSupabaseClient();
	const { data, error } = await supabase
		.from("vendor_customers")
		.select("id, slug, name, domain, since, tier, verified, features, consent")
		.eq("vendor_id", vendor.id)
		.order("created_at", { ascending: true });

	if (error) return NextResponse.json({ error: error.message }, { status: 400 });

	return NextResponse.json({ customers: data ?? [] });
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
 */
export async function POST(request: Request) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const body = await request.json().catch(() => null);
	if (
		!body ||
		typeof body.slug !== "string" ||
		typeof body.name !== "string" ||
		typeof body.domain !== "string" ||
		typeof body.since !== "string" ||
		!body.slug.trim() ||
		!body.name.trim() ||
		!body.domain.trim() ||
		!body.since.trim()
	) {
		return NextResponse.json(
			{ error: "slug, name, domain, and since are required" },
			{ status: 400 },
		);
	}

	const consent: Consent = body.consent === "named" ? "named" : "anonymous";

	const supabase = await createServerSupabaseClient();
	const { data, error } = await supabase
		.from("vendor_customers")
		.insert({
			vendor_id: vendor.id,
			slug: body.slug.trim(),
			name: body.name.trim(),
			domain: body.domain.trim(),
			since: body.since.trim(),
			consent,
			tier: 1,
			verified: false,
			features: [],
		})
		.select("id, slug, name, domain, since, tier, verified, features, consent")
		.single();

	if (error) return NextResponse.json({ error: error.message }, { status: 400 });

	return NextResponse.json({ customer: data }, { status: 201 });
}
