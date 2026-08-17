import { NextResponse } from "next/server";
import { currentVendor } from "@/lib/vendors/session";
import { dbClient } from "@/lib/db/client";

/**
 * `GET /api/vendor/status` — "is this vendor receiving events?" for the
 * dashboard's live indicator. Resolves the vendor from the session
 * (`currentVendor()`, RLS-backed), then counts `hot_events` rows for that
 * vendor's slug in the last 24h via the service-role client — `hot_events`
 * has no RLS policies (see src/lib/db/client.ts), so this is the only client
 * that can read it.
 */
export async function GET() {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

	const db = dbClient();
	if (!db) return NextResponse.json({ error: "Not configured" }, { status: 404 });

	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const { count, error } = await db
		.from("hot_events")
		.select("*", { count: "exact", head: true })
		.eq("vendor_slug", vendor.slug)
		.gte("receipt_ts", since);

	if (error) {
		return NextResponse.json({ error: "Count failed" }, { status: 500 });
	}

	const total = count ?? 0;
	return NextResponse.json({ receiving: total > 0, count: total });
}
