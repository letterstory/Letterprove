import { NextResponse } from "next/server";
import { currentVendor } from "@/lib/vendors/session";
import { getVendorStatus } from "@/lib/vendors/status";

/**
 * `GET /api/vendor/status` — "is this vendor receiving events?" for the
 * dashboard's live indicator. Resolves the vendor from the session
 * (`currentVendor()`, RLS-backed), then delegates the count to
 * src/lib/vendors/status.ts, shared with the bearer-token tool dispatcher
 * (src/lib/tools/registry.ts).
 */
export async function GET() {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

	const result = await getVendorStatus(vendor.id);
	if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

	return NextResponse.json({ receiving: result.receiving, count: result.count });
}
