import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/server";
import { isStaffUser } from "@/lib/staff/allowlist";
import { promoteDomain, type PromoteFailure } from "@/lib/staff/promote";

/**
 * `POST /api/staff/customers` — create a customer record from a domain we have
 * actually observed.
 *
 * Staff-only, and the gate is load-bearing for the same reason as
 * /api/staff/tiers: the request body names a customer domain, and the response
 * confirms whether we have observations for it. Signed-out returns 404 rather
 * than 401 — an internal surface that confirms its own existence to anyone who
 * guesses the URL is telling people where to push.
 *
 * This WRITES, unlike every other staff surface, so it is worth being precise
 * about what it can and cannot cause: it creates one anonymous, tier-1-ceiling
 * customer record. It cannot name a customer publicly (consent stays
 * `anonymous`), cannot grant a tier (earned() re-derives it at publish time),
 * and cannot invent one (the domain must have been observed). See
 * lib/staff/promote.ts.
 */

const STATUS: Record<PromoteFailure, number> = {
	vendor_unreadable: 404,
	not_attributable: 422,
	not_observed: 422,
	already_exists: 409,
	storage_unavailable: 503,
	write_failed: 500,
};

export async function POST(request: Request) {
	// A session is not staff. This endpoint WRITES customer records for any
	// vendor, and /api/staff/* sits outside proxy.ts's matcher, so the allowlist
	// is checked right here rather than assumed to have happened upstream.
	const user = await getUser();
	if (!isStaffUser(user?.id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

	const body = await request.json().catch(() => null);
	const vendor = typeof body?.vendor === "string" ? body.vendor.trim() : "";
	const domain = typeof body?.domain === "string" ? body.domain.trim() : "";

	if (!vendor || !domain) {
		return NextResponse.json({ error: "vendor and domain are required" }, { status: 400 });
	}

	const result = await promoteDomain(vendor, domain);
	if (!result.ok) {
		return NextResponse.json({ error: result.reason, detail: result.detail }, { status: STATUS[result.reason] });
	}

	return NextResponse.json({ customer: result }, { status: 201, headers: { "cache-control": "no-store" } });
}
