import { dbClient } from "@/lib/db/client";

export type VendorStatusResult =
	| { ok: true; receiving: boolean; installed: boolean; count: number }
	| { ok: false; status: number; error: string };

/**
 * "Is this vendor receiving events?" — shared by the dashboard's cookie route
 * and the bearer-token tool dispatcher. Always goes through the service-role
 * client: `hot_events` has no RLS policies (see src/lib/db/client.ts), so
 * that's the only client that can read it either way, and it also lets a
 * bearer caller (which has no session-bound client at all) resolve the
 * vendor's slug from its id without a second credential.
 *
 * `installed` answers a narrower question than `receiving`: has attest.js
 * ever successfully booted on this vendor's page at all (config_pings), vs.
 * has it ever fired an event (hot_events). A marketing page with the script
 * installed but no identify()/signup()/login() call anywhere is `installed:
 * true, receiving: false` forever — that's not broken, see ping.ts — and
 * without this field it's indistinguishable from a script that never loaded.
 */
export async function getVendorStatus(vendorId: string): Promise<VendorStatusResult> {
	const db = dbClient();
	if (!db) return { ok: false, status: 404, error: "Not configured" };

	const { data: vendor } = await db.from("vendors").select("slug").eq("id", vendorId).maybeSingle();
	if (!vendor) return { ok: false, status: 404, error: "Not configured" };

	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const [{ count, error }, { data: ping }] = await Promise.all([
		db.from("hot_events").select("*", { count: "exact", head: true }).eq("vendor_slug", vendor.slug).gte("receipt_ts", since),
		db.from("config_pings").select("vendor_slug").eq("vendor_slug", vendor.slug).maybeSingle(),
	]);

	if (error) return { ok: false, status: 500, error: "Count failed" };

	const total = count ?? 0;
	return { ok: true, receiving: total > 0, installed: ping != null, count: total };
}
