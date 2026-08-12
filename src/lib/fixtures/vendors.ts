/**
 * Identity fixtures — a fictional vendor and its customers.
 *
 * The publishing half of Letterprove is entirely independent of collection, so
 * it was originally built and demonstrated against static snapshot numbers
 * here too. Those are gone now: `sessions_30d`/`seats_active` come from
 * `currentSnapshot` (src/rollup/snapshots.ts), a live query over `hot_rollups`,
 * keyed by the `domain` below. What's left here — identity, tier, features — is
 * still genuinely static: nothing in `hot_events` carries a customer name or a
 * feature list (see events.ts), so there is no rollup that could replace it.
 *
 * NOTHING IN HERE IS EVIDENCE. Vantage does not exist. Its customers' domains
 * are not registered and will never emit real events; every proof this vendor
 * publishes honestly shows sessions_30d: 0 until someone points a real
 * attest.js at one of them.
 */

import type { Tier } from "../attest/types";

export interface CustomerFixture {
	slug: string;
	name: string;
	/** Join key into hot_events/hot_rollups — the `domain` an observe payload carries. */
	domain: string;
	since: string;
	tier: Tier;
	verified: boolean;
	features: string[];
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
			domain: "acme-corp.example",
			since: "2023-03",
			tier: 2,
			verified: true,
			features: ["sso", "api", "analytics"],
		},
		{
			slug: "northwind",
			name: "Northwind",
			domain: "northwind.example",
			since: "2024-08",
			tier: 2,
			verified: true,
			features: ["sso", "api", "analytics", "sla"],
		},
		{
			slug: "globex",
			name: "Globex",
			domain: "globex.example",
			since: "2022-11",
			// Tier 1 on purpose: observed in a browser, not yet bound to
			// infrastructure facts. The proof page must be able to show a weaker
			// claim honestly rather than rounding everything up to "verified".
			tier: 1,
			verified: false,
			features: ["sso", "audit_log", "api"],
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
