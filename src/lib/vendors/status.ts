import { dbClient } from "@/lib/db/client";
import { rejectedOriginsFor, type RejectedOrigin } from "@/lib/telemetry/rejected-origins";
import { rowDomainProof } from "@/lib/vendors/site-proof";
import type { DomainProof } from "@/lib/attest/domain-proof";

export type VendorStatusResult =
	| {
			ok: true;
			receiving: boolean;
			installed: boolean;
			count: number;
			publishedAt: string | null;
			listed: boolean;
			/** First accepted event ever. Survives hot_events' 35-day retention. */
			everReceivedAt: string | null;
			/** Latest accepted event still held (35 days), or null. */
			lastReceivedAt: string | null;
			/** Origins whose events were dropped in the last 24h. */
			rejectedOrigins: RejectedOrigin[];
			/** none / site / dns: how the domain is proven, and so the highest tier it can carry. */
			domainProof: DomainProof;
			siteVerifiedAt: string | null;
			siteVerifiedUrl: string | null;
	  }
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
 *
 * `publishedAt` is a third, separate question: is any of this PUBLIC. A vendor
 * is private until someone publishes them, and collection runs either way, so
 * "receiving events" and "serving proofs" are no longer the same state and a
 * status tool that answered only the first would be quietly misleading.
 */
export async function getVendorStatus(vendorId: string): Promise<VendorStatusResult> {
	const db = dbClient();
	if (!db) return { ok: false, status: 404, error: "Not configured" };

	const { data: vendor } = await db
		.from("vendors")
		.select("slug, domain, proofs_published_at, proofs_listed, first_event_at, domain_verified_at, site_verified_at, site_verified_url")
		.eq("id", vendorId)
		.maybeSingle();
	if (!vendor) return { ok: false, status: 404, error: "Not configured" };

	const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const [{ count, error }, { data: ping }, { data: latest }, rejectedOrigins] = await Promise.all([
		db.from("hot_events").select("*", { count: "exact", head: true }).eq("vendor_slug", vendor.slug).gte("receipt_ts", since),
		db.from("config_pings").select("vendor_slug").eq("vendor_slug", vendor.slug).maybeSingle(),
		db
			.from("hot_events")
			.select("receipt_ts")
			.eq("vendor_slug", vendor.slug)
			.order("receipt_ts", { ascending: false })
			.limit(1)
			.maybeSingle<{ receipt_ts: string }>(),
		rejectedOriginsFor(vendorId, vendor.domain ?? ""),
	]);

	if (error) return { ok: false, status: 500, error: "Count failed" };

	const total = count ?? 0;
	return {
		ok: true,
		receiving: total > 0,
		installed: ping != null,
		count: total,
		publishedAt: vendor.proofs_published_at ?? null,
		listed: vendor.proofs_listed !== false,
		everReceivedAt: iso(vendor.first_event_at ?? latest?.receipt_ts ?? null),
		lastReceivedAt: iso(latest?.receipt_ts ?? null),
		rejectedOrigins,
		domainProof: rowDomainProof(vendor),
		siteVerifiedAt: iso(vendor.site_verified_at ?? null),
		siteVerifiedUrl: vendor.site_verified_url ?? null,
	};
}

function iso(v: string | null): string | null {
	if (!v) return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
