/**
 * Fixture data — a fictional vendor and its customers.
 *
 * The publishing half of Letterprove is entirely independent of collection, so
 * it is built and demonstrated against these until Steve's telemetry lands.
 * When it does, this module is replaced by a rollup over real observations and
 * nothing downstream of it changes: the routes, signing, chaining, JSON-LD and
 * verifier all consume the same shape.
 *
 * Everything here is deliberately STATIC — fixed timestamps, fixed counts. A
 * signature covers the bytes, so a `Date.now()` anywhere in this file would
 * mint a different chain on every request and make the tests meaningless.
 *
 * NOTHING IN HERE IS EVIDENCE. Vantage does not exist.
 */

import type { Tier } from "../attest/types";

export interface SnapshotFixture {
	observed_through: string;
	published_at: string;
	sessions_30d: number;
	seats_active: number;
}

export interface CustomerFixture {
	slug: string;
	name: string;
	since: string;
	tier: Tier;
	verified: boolean;
	features: string[];
	/** Oldest first — the order the chain is built in. */
	snapshots: SnapshotFixture[];
}

export interface VendorFixture {
	slug: string;
	name: string;
	domain: string;
	category: string;
	/** Publishable key `attest.js` sends on every event — origin-pinned to `domain`. */
	key: string;
	customers: CustomerFixture[];
}

/** Every feature we know how to attest, in display order. */
export const FEATURES = ["sso", "audit_log", "api", "analytics", "sla"] as const;

const VANTAGE: VendorFixture = {
	slug: "vantage",
	name: "Vantage",
	domain: "vantage.example",
	category: "customer data platforms",
	key: "lp_live_vantage_9f2c",
	customers: [
		{
			slug: "acme-corp",
			name: "Acme Corp",
			since: "2023-03",
			tier: 2,
			verified: true,
			features: ["sso", "api", "analytics"],
			snapshots: [
				{ observed_through: "2026-06-30T00:00:00Z", published_at: "2026-06-30T02:04:00Z", sessions_30d: 3908, seats_active: 141 },
				{ observed_through: "2026-07-31T00:00:00Z", published_at: "2026-07-31T02:06:00Z", sessions_30d: 4055, seats_active: 145 },
				{ observed_through: "2026-08-09T00:00:00Z", published_at: "2026-08-09T02:05:00Z", sessions_30d: 4182, seats_active: 148 },
			],
		},
		{
			slug: "northwind",
			name: "Northwind",
			since: "2024-08",
			tier: 2,
			verified: true,
			features: ["sso", "api", "analytics", "sla"],
			snapshots: [
				{ observed_through: "2026-06-30T00:00:00Z", published_at: "2026-06-30T02:04:00Z", sessions_30d: 1602, seats_active: 38 },
				{ observed_through: "2026-07-31T00:00:00Z", published_at: "2026-07-31T02:06:00Z", sessions_30d: 1711, seats_active: 41 },
				{ observed_through: "2026-08-09T00:00:00Z", published_at: "2026-08-09T02:05:00Z", sessions_30d: 1760, seats_active: 43 },
			],
		},
		{
			slug: "globex",
			name: "Globex",
			since: "2022-11",
			// Tier 1 on purpose: observed in a browser, not yet bound to
			// infrastructure facts. The proof page must be able to show a weaker
			// claim honestly rather than rounding everything up to "verified".
			tier: 1,
			verified: false,
			features: ["sso", "audit_log", "api"],
			snapshots: [
				{ observed_through: "2026-07-31T00:00:00Z", published_at: "2026-07-31T02:06:00Z", sessions_30d: 884, seats_active: 22 },
				{ observed_through: "2026-08-09T00:00:00Z", published_at: "2026-08-09T02:05:00Z", sessions_30d: 903, seats_active: 23 },
			],
		},
	],
};

const VENDORS: VendorFixture[] = [VANTAGE];

export function allVendors(): VendorFixture[] {
	return VENDORS;
}

export function findVendor(slug: string): VendorFixture | undefined {
	return VENDORS.find((v) => v.slug === slug);
}

export function findVendorByKey(key: string): VendorFixture | undefined {
	return VENDORS.find((v) => v.key === key);
}

export function findCustomer(vendor: VendorFixture, slug: string): CustomerFixture | undefined {
	return vendor.customers.find((c) => c.slug === slug);
}
