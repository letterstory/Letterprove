/**
 * Vendor/customer identity — DB-backed (supabase/migrations/20260814230000_vendor_accounts.sql).
 *
 * This module used to be static fixtures. It kept the same file path and the
 * same exported function signatures (now async) on purpose: every call site
 * that read `allVendors()`/`findVendor()`/etc. only had to gain an `await`,
 * not a rewrite, and the two identities that existed as fixtures — `vantage`
 * (fictional demo data) and `lettertrace` (a REAL, LIVE integration —
 * `lettertrace.com`'s `domain` is what `POST /v1/observe` pins the browser's
 * `Origin` header against) — were seeded into the `vendors` table at the
 * exact same slug/domain/key values, so nothing that already depends on them
 * changed behavior.
 *
 * Reads go through the service-role client (`dbClient`, src/lib/db/client.ts)
 * and bypass RLS — every caller of this module today is trusted server code
 * (the collector, the rollup, the proof/attest pipeline), the same trust
 * level static fixtures had. RLS on these tables exists for the vendor
 * dashboard (anon key + user session), added alongside this file — see
 * src/lib/vendors/dashboard.ts.
 *
 * NOTHING IN VANTAGE IS EVIDENCE. It does not exist. Its customers' domains
 * are not registered and will never emit real events; every proof this vendor
 * publishes honestly shows sessions_30d: 0 until someone points a real
 * attest.js at one of them.
 */

import type { Tier } from "../attest/types";
import { dbClient } from "../db/client";

/**
 * Whether this customer has agreed to be named in public.
 *
 * Publishing *"Acme runs SSO, 148 seats, 92% adoption"* discloses **Acme's**
 * data, and Acme is our customer's customer — someone with no relationship to
 * us. README § Consent settles the rule: build named, ship anonymized, flip as
 * consent lands.
 *
 * `anonymous` is the default and must stay the default. A customer who has
 * never been asked has not agreed, and the failure mode of guessing wrong here
 * is a signed, immutable, public disclosure of a third party's usage.
 */
export type Consent = "named" | "anonymous";

export interface CustomerFixture {
	slug: string;
	name: string;
	/** Join key into hot_events/hot_rollups — the `domain` an observe payload carries. */
	domain: string;
	since: string;
	tier: Tier;
	verified: boolean;
	features: string[];
	/**
	 * Omitted means `anonymous`. Consent is opt-in, so the absent case is the
	 * private one — a new customer added without thinking about consent is
	 * silently withheld, never silently published.
	 */
	consent?: Consent;
}

/** Consent, with the safe default applied. The only way publication should ask. */
export function consentOf(customer: CustomerFixture): Consent {
	return customer.consent ?? "anonymous";
}

export interface VendorFixture {
	slug: string;
	name: string;
	domain: string;
	category: string;
	/** Publishable key `attest.js` sends on every event — origin-pinned to `domain`. */
	key: string;
	/**
	 * Whether DNS control of `domain` has been proven. Origin-pinning only
	 * constrains browsers, so without this an observation is an assertion —
	 * see lib/vendors/verification.ts. Caps everything at tier 0 when false.
	 */
	domainVerified: boolean;
	customers: CustomerFixture[];
}

/** Every feature we know how to attest, in display order. */
export const FEATURES = ["sso", "audit_log", "api", "analytics", "sla"] as const;

interface VendorRow {
	slug: string;
	name: string;
	domain: string;
	domain_verified_at?: string | null;
	category: string;
	key: string;
}

interface CustomerRow {
	vendor_id: string;
	slug: string;
	name: string;
	domain: string;
	since: string;
	tier: Tier;
	verified: boolean;
	features: string[];
	consent: Consent;
}

function toFixture(row: VendorRow, customers: CustomerRow[]): VendorFixture {
	return {
		slug: row.slug,
		name: row.name,
		domain: row.domain,
		category: row.category,
		key: row.key,
		domainVerified: Boolean(row.domain_verified_at),
		customers: customers.map((c) => ({
			slug: c.slug,
			name: c.name,
			domain: c.domain,
			since: c.since,
			tier: c.tier,
			verified: c.verified,
			features: c.features,
			consent: c.consent,
		})),
	};
}

/**
 * There is no service-role DB in local dev without env set up, and this
 * module's callers (the live collector included) must not throw on a config
 * gap — same failure posture the collector already has for an unknown key.
 * An empty vendor list is the correct answer to "who is registered" when we
 * can't reach the database, not a thrown error.
 */
export async function allVendors(): Promise<VendorFixture[]> {
	const db = dbClient();
	if (!db) return [];

	const { data: rows } = await db.from("vendors").select("id, slug, name, domain, category, key, domain_verified_at");
	if (!rows || rows.length === 0) return [];

	const { data: customerRows } = await db
		.from("vendor_customers")
		.select("vendor_id, slug, name, domain, since, tier, verified, features, consent")
		.in(
			"vendor_id",
			rows.map((r) => r.id),
		);

	const customersByVendor = new Map<string, CustomerRow[]>();
	for (const c of (customerRows ?? []) as unknown as (CustomerRow & { vendor_id: string })[]) {
		const list = customersByVendor.get(c.vendor_id) ?? [];
		list.push(c);
		customersByVendor.set(c.vendor_id, list);
	}

	return rows.map((row) =>
		toFixture(
			{ slug: row.slug, name: row.name, domain: row.domain, category: row.category, key: row.key },
			customersByVendor.get(row.id) ?? [],
		),
	);
}

export async function findVendor(slug: string): Promise<VendorFixture | undefined> {
	const db = dbClient();
	if (!db) return undefined;

	const { data: row } = await db
		.from("vendors")
		.select("id, slug, name, domain, category, key, domain_verified_at")
		.eq("slug", slug)
		.maybeSingle();
	if (!row) return undefined;

	const { data: customerRows } = await db
		.from("vendor_customers")
		.select("vendor_id, slug, name, domain, since, tier, verified, features, consent")
		.eq("vendor_id", row.id);

	return toFixture(
		{ slug: row.slug, name: row.name, domain: row.domain, category: row.category, key: row.key },
		(customerRows ?? []) as unknown as CustomerRow[],
	);
}

/**
 * Keyed lookup for the live collector (`POST /v1/observe`, `GET /v1/config`)
 * — `key` is not a secret (it ships in every page's HTML) but it is unique,
 * so this stays a direct equality lookup rather than a table scan.
 */
export async function findVendorByKey(key: string): Promise<VendorFixture | undefined> {
	const db = dbClient();
	if (!db) return undefined;

	const { data: row } = await db
		.from("vendors")
		.select("id, slug, name, domain, category, key, domain_verified_at")
		.eq("key", key)
		.maybeSingle();
	if (!row) return undefined;

	const { data: customerRows } = await db
		.from("vendor_customers")
		.select("vendor_id, slug, name, domain, since, tier, verified, features, consent")
		.eq("vendor_id", row.id);

	return toFixture(
		{ slug: row.slug, name: row.name, domain: row.domain, category: row.category, key: row.key },
		(customerRows ?? []) as unknown as CustomerRow[],
	);
}

export function findCustomer(vendor: VendorFixture, slug: string): CustomerFixture | undefined {
	return vendor.customers.find((c) => c.slug === slug);
}
