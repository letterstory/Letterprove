/**
 * Who is on the platform, and what are they actually publishing?
 *
 * The other two staff views answer narrower questions — collection health asks
 * *is anything arriving*, the tier report asks *why is this domain not a
 * published claim*. Neither answers the one you need first when someone says
 * "a vendor emailed us": who are they, who owns the account, what key are they
 * installed with, and is any of it live.
 *
 * Everything here is already in the database. The value is the join: vendor
 * identity, the humans attached to it, the customers they have declared, and
 * what actually publishes — which today is usually the aggregate and nothing
 * else, because naming a customer needs that customer's consent.
 *
 * The publishable key is shown in full ON PURPOSE. It ships in the HTML of
 * every authenticated page on the vendor's own site, so it is not a secret —
 * the origin pin is what makes it safe. Masking it here would imply a
 * confidentiality it does not have, and support answering "what is my key"
 * would have to go to the database instead.
 */

import { dbClient } from "@/lib/db/client";
import { allVendors, consentOf } from "@/lib/fixtures/vendors";
import { aggregateBody } from "@/lib/attest/aggregate";
import type { Tier } from "@/lib/attest/types";

export interface VendorMember {
	email: string;
	role: string;
}

export interface VendorRow {
	slug: string;
	name: string;
	domain: string;
	category: string;
	key: string;
	members: VendorMember[];
	customers: { total: number; named: number };
	/** What the vendor-level attestation currently says, or null if it publishes nothing. */
	aggregate: { companies: number; sessions: number; tier: Tier } | null;
}

/**
 * Resolve the humans behind each vendor.
 *
 * `vendor_members` holds user ids; the addresses live in `auth.users`, which
 * PostgREST does not expose. So this goes through the auth admin API, which
 * the service-role client already has. Failing soft: a roster with no email
 * attached is still worth showing, and this is a support convenience rather
 * than anything the product depends on.
 */
async function membersByVendor(): Promise<Map<string, VendorMember[]>> {
	const byVendor = new Map<string, VendorMember[]>();
	const db = dbClient();
	if (!db) return byVendor;

	const { data: rows, error } = await db.from("vendor_members").select("vendor_id, user_id, role");
	if (error) {
		console.error("[letterprove:vendors] member query failed", error.message);
		return byVendor;
	}

	const { data: userPage, error: userError } = await db.auth.admin.listUsers({ perPage: 1000 });
	if (userError) {
		console.error("[letterprove:vendors] user lookup failed", userError.message);
	}
	const emailById = new Map((userPage?.users ?? []).map((u) => [u.id, u.email ?? u.id]));

	// vendor_members keys on vendor_id (uuid); the rest of this module keys on
	// slug, so resolve through the vendors table rather than assuming they match.
	const { data: vendorRows } = await db.from("vendors").select("id, slug");
	const slugById = new Map(((vendorRows ?? []) as { id: string; slug: string }[]).map((v) => [v.id, v.slug]));

	for (const r of (rows ?? []) as { vendor_id: string; user_id: string; role: string }[]) {
		const slug = slugById.get(r.vendor_id);
		if (!slug) continue;
		const list = byVendor.get(slug) ?? [];
		list.push({ email: emailById.get(r.user_id) ?? r.user_id, role: r.role });
		byVendor.set(slug, list);
	}
	return byVendor;
}

export async function vendorRoster(): Promise<VendorRow[] | null> {
	const db = dbClient();
	// Null, not an empty roster: "no datastore" and "no vendors" look the same
	// once rendered and only one of them is a problem.
	if (!db) return null;

	const [vendors, members] = await Promise.all([allVendors(), membersByVendor()]);

	return Promise.all(
		vendors.map(async (v) => {
			const agg = await aggregateBody(v.slug);
			return {
				slug: v.slug,
				name: v.name,
				domain: v.domain,
				category: v.category,
				key: v.key,
				members: members.get(v.slug) ?? [],
				customers: {
					total: v.customers.length,
					named: v.customers.filter((c) => consentOf(c) === "named").length,
				},
				// A null aggregate means telemetry could not be read, which is not
				// the same as publishing nothing — the page distinguishes them.
				aggregate: agg
					? { companies: agg.companies_observed, sessions: agg.sessions, tier: agg.tier }
					: null,
			};
		})
	);
}
