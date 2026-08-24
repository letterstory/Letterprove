import { NextResponse } from "next/server";
import { currentVendor } from "@/lib/vendors/session";
import { connectionFor } from "@/lib/stripe/credentials";
import { syncVendorPayments } from "@/lib/stripe/sync";

/**
 * POST /api/vendor/stripe/sync — pull payments now.
 *
 * Session-scoped like every other vendor route: the sync always runs for the
 * signed-in vendor, never one named in the request.
 *
 * The connection is returned alongside the summary so the card can show the
 * new last-synced time and any error Stripe reported without a second request.
 */
export async function POST() {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const result = await syncVendorPayments(vendor.id, vendor.slug);
	if (!result.ok) {
		// 502: the failure is upstream at Stripe, not in the caller's request.
		// The connection still comes back so the card can show what went wrong.
		return NextResponse.json(
			{ error: result.error, connection: await connectionFor(vendor.id) },
			{ status: 502 }
		);
	}

	return NextResponse.json({
		summary: {
			matched: result.matched,
			unmatched: result.unmatched,
			testMode: result.testMode,
			truncated: result.truncated,
		},
		connection: await connectionFor(vendor.id),
	});
}
