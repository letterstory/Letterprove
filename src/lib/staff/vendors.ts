/**
 * Who is on the platform, and what are they actually publishing?
 *
 * The other two staff views answer narrower questions — collection health asks
 * *is anything arriving*, the tier report asks *why is this domain not a
 * published claim*. Neither answers the one you need first when someone says
 * "a vendor emailed us": who they are, what key they're installed with, and
 * is any of it live.
 *
 * Everything here is already in the database. The value is the join: vendor
 * identity, the customers they have declared, and what actually publishes —
 * which today is usually the aggregate and nothing else, because naming a
 * customer needs that customer's consent.
 *
 * This used to also resolve the humans behind each vendor via `vendor_members`
 * — dropped by the auth-unification migration (20260828130000). Membership now
 * lives entirely in Letterstory's `organization_users`, which this deployment
 * has no read access to (a soft cross-database reference, per
 * 20260825060000's own note); "who do I contact about this vendor" is a
 * Letterstory-side lookup now, not something this roster can answer.
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

export interface VendorRow {
	slug: string;
	name: string;
	domain: string;
	category: string;
	key: string;
	customers: { total: number; named: number };
	/** When this vendor's proofs went public, or null while they are private. */
	published_at: string | null;
	/** What the vendor-level attestation currently says, or null if it publishes nothing. */
	aggregate: { companies: number; sessions: number; tier: Tier } | null;
}

export async function vendorRoster(): Promise<VendorRow[] | null> {
	const db = dbClient();
	// Null, not an empty roster: "no datastore" and "no vendors" look the same
	// once rendered and only one of them is a problem.
	if (!db) return null;

	const vendors = await allVendors();

	return Promise.all(
		vendors.map(async (v) => {
			const agg = await aggregateBody(v.slug);
			return {
				slug: v.slug,
				name: v.name,
				domain: v.domain,
				category: v.category,
				key: v.key,
				customers: {
					total: v.customers.length,
					named: v.customers.filter((c) => consentOf(c) === "named").length,
				},
				// Whether anything below is actually reachable by a stranger. A
				// private vendor's aggregate is computed and frozen exactly as a
				// public one's, so without this the roster reads identically for
				// a vendor whose proofs are live and one whose proofs 404.
				published_at: v.proofsPublishedAt,
				// A null aggregate means telemetry could not be read, which is not
				// the same as publishing nothing — the page distinguishes them.
				aggregate: agg
					? { companies: agg.companies_observed, sessions: agg.sessions, tier: agg.tier }
					: null,
			};
		})
	);
}
