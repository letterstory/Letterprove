import { NextResponse, type NextRequest } from "next/server";
import { recordConsentDecision } from "@/lib/vendors/consent";

/**
 * Handles the plain HTML form POST from ../page.tsx — same reasoning as
 * /api/oauth/authorize/consent: this recipient has no Letterprove account and
 * may be reading this from an email client, so the flow can't depend on
 * client-side JavaScript running at all.
 *
 * Lives one level below the page (../consent/respond, not ../consent) because
 * Next.js refuses a page.tsx and a route.ts in the same segment — they'd both
 * claim GET/POST on the identical path.
 *
 * Redirects back to the page with `done` set rather than rendering a result
 * directly, so a reload after submitting shows the same confirmation instead
 * of re-submitting the form.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ vendor: string; customer: string }> }) {
	const { vendor, customer } = await params;
	const form = await request.formData();
	const token = String(form.get("token") ?? "");
	const decision = String(form.get("decision") ?? "");

	const url = new URL(`/attest/${vendor}/${customer}/consent`, request.url);
	// Preserve the token on any redirect that doesn't confirm a decision, so
	// the page re-runs lookupConsentRequest and shows the real reason
	// (invalid, expired, already countersigned) instead of a generic dead end.
	if (token) url.searchParams.set("token", token);

	if (decision !== "approve" && decision !== "decline") {
		return NextResponse.redirect(url);
	}

	const result = await recordConsentDecision(vendor, customer, token, decision);
	if (!result.ok) return NextResponse.redirect(url);

	url.searchParams.delete("token");
	url.searchParams.set("done", decision);
	return NextResponse.redirect(url);
}
