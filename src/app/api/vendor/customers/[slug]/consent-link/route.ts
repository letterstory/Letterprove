import { NextResponse } from "next/server";
import { currentVendor } from "@/lib/vendors/session";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { clearConsentToken, generateConsentLink } from "@/lib/vendors/customers";
import { sendConsentRequest } from "@/lib/email/consent";

/**
 * POST /api/vendor/customers/{slug}/consent-link — email the customer a link
 * to approve their own attestation. Same ownership pattern as PATCH/DELETE in
 * ../route.ts: scoped by (vendor_id, slug), RLS-backed, 404 on no match rather
 * than a separate ownership check.
 *
 * The response deliberately does NOT contain the token, the path, or the URL.
 * That is the entire point of this endpoint's redesign: the vendor names a
 * recipient on the customer's domain, Letterprove delivers, and the vendor
 * never holds the credential that produces a tier-4 counter-signature. A
 * response that echoed the link back would restore the hole exactly.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const { slug } = await params;
	const payload = await request.json().catch(() => null);

	const supabase = await createServerSupabaseClient();
	const result = await generateConsentLink(supabase, vendor.id, slug, payload?.contactEmail);
	if (!result.ok) return NextResponse.json(result.body, { status: result.status });

	const { token, expiresAt, sentTo, customerName } = result.data;

	// Absolute, and derived from this request rather than a configured host —
	// same reason the install snippet is (see #44's cdn.letterprove.com fix):
	// a hardcoded origin is a link that silently points at nothing.
	const url = new URL(`/attest/${vendor.slug}/${slug}/consent?token=${token}`, request.url).toString();

	const sent = await sendConsentRequest({
		to: sentTo,
		vendorName: vendor.name,
		customerName,
		url,
		expiresAt,
	});

	if (!sent.ok) {
		// Roll the token back. Leaving it live would strand the customer's only
		// route to approving behind an email that never arrived, and the vendor
		// has no way to see that from the dashboard.
		await clearConsentToken(supabase, vendor.id, slug, token);
		return NextResponse.json({ error: sent.error }, { status: 502 });
	}

	return NextResponse.json({ sentTo, expiresAt });
}
