import { NextResponse } from "next/server";
import { currentVendor } from "@/lib/vendors/session";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { generateConsentLink } from "@/lib/vendors/customers";

/**
 * POST /api/vendor/customers/{slug}/consent-link — mint (or re-mint) the
 * unguessable link the vendor sends their customer to approve their own
 * attestation. Same ownership pattern as PATCH/DELETE in ../route.ts: scoped
 * by (vendor_id, slug), RLS-backed, 404 on no match rather than a separate
 * ownership check.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const { slug } = await params;
	const supabase = await createServerSupabaseClient();
	const result = await generateConsentLink(supabase, vendor.id, slug);
	if (!result.ok) return NextResponse.json(result.body, { status: result.status });

	return NextResponse.json({
		token: result.data.token,
		expiresAt: result.data.expiresAt,
		path: `/attest/${vendor.slug}/${slug}/consent?token=${result.data.token}`,
	});
}
