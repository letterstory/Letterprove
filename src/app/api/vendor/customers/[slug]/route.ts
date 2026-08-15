import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { currentVendor } from "@/lib/vendors/session";
import { FEATURES, type Consent } from "@/lib/fixtures/vendors";

const FEATURE_SET: readonly string[] = FEATURES;

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
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const { slug } = await params;
	const body = await request.json().catch(() => null);
	if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

	const update: Record<string, unknown> = {};
	if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
	if (typeof body.domain === "string" && body.domain.trim()) update.domain = body.domain.trim();
	if (typeof body.since === "string" && body.since.trim()) update.since = body.since.trim();
	if (body.consent === "named" || body.consent === "anonymous") {
		update.consent = body.consent as Consent;
	}
	if (Array.isArray(body.features)) {
		update.features = body.features.filter(
			(f: unknown): f is string => typeof f === "string" && FEATURE_SET.includes(f),
		);
	}

	if (Object.keys(update).length === 0) {
		return NextResponse.json({ error: "no updatable fields provided" }, { status: 400 });
	}

	const supabase = await createServerSupabaseClient();
	const { data, error } = await supabase
		.from("vendor_customers")
		.update(update)
		.eq("vendor_id", vendor.id)
		.eq("slug", slug)
		.select("id, slug, name, domain, since, tier, verified, features, consent")
		.maybeSingle();

	if (error) return NextResponse.json({ error: error.message }, { status: 400 });
	if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

	return NextResponse.json({ customer: data });
}

/** DELETE /api/vendor/customers/{slug} — same trust-RLS, 404-on-empty pattern as PATCH. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const { slug } = await params;
	const supabase = await createServerSupabaseClient();
	const { data, error } = await supabase
		.from("vendor_customers")
		.delete()
		.eq("vendor_id", vendor.id)
		.eq("slug", slug)
		.select("id")
		.maybeSingle();

	if (error) return NextResponse.json({ error: error.message }, { status: 400 });
	if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

	return new NextResponse(null, { status: 204 });
}
