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
	/**
	 * When this customer approved their own attestation via the consent link
	 * (src/app/attest/[vendor]/[customer]/consent). Null until then. This is
	 * tier-4 evidence in its own right — see earned() in ../attest/body.ts —
	 * independent of `tier`, which is only ever a ceiling on what the vendor's
	 * own observation pipeline can earn.
	 */
	countersignedAt?: string | null;
}

/** Consent, with the safe default applied. The only way publication should ask. */
export function consentOf(customer: CustomerFixture): Consent {
	return customer.consent ?? "anonymous";
}

export interface VendorFixture {
	/**
	 * Row id. Carried because payment evidence and Stripe credentials are keyed
	 * on it rather than on the slug — a slug is user-facing and could in
	 * principle be renamed, and a renamed slug silently orphaning a vendor's
	 * tier-3 evidence is not a failure worth risking. Every lookup in this file
	 * already selected it; only toFixture was dropping it.
	 */
	id: string;
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
	/**
	 * When this vendor's proofs became public, or null while they are private.
	 *
	 * A vendor is private until someone publishes it. Everything internal runs
	 * regardless — collection, rollup, freeze, signing, countersigning — so the
	 * chain has no hole in it and publishing is a flip rather than a rebuild.
	 * What this gates is publication and only publication: see
	 * `findPublishedVendor` below, which is the resolution point every public
	 * route goes through.
	 *
	 * Deliberately not called `publishedAt`. An attestation body already has a
	 * `published_at` meaning "when this document was signed", and proofs.ts
	 * reads both in the same function.
	 */
	proofsPublishedAt: string | null;
	customers: CustomerFixture[];
}

/** Every feature we know how to attest, in display order. */
export const FEATURES = ["sso", "audit_log", "api", "analytics", "sla"] as const;

/**
 * One list, four lookups. Hand-copied subsets are how `domain_verified_at`
 * once went missing from all three vendor selects at once, silently capping
 * every vendor at tier 0 — and `proofs_published_at` would fail the same way,
 * except that a missing publication flag reads as "private" and takes a live
 * vendor's proofs dark instead.
 */
const VENDOR_COLUMNS = "id, slug, name, domain, category, key, domain_verified_at, proofs_published_at";

/**
 * The columns every vendor_customers read here selects, for the same reason.
 * Distinct from `CUSTOMER_COLUMNS` in lib/vendors/customers.ts, which is the
 * TOOL-facing shape: that one carries `id` and this one carries `vendor_id`.
 */
const VENDOR_CUSTOMER_COLUMNS =
	"vendor_id, slug, name, domain, since, tier, verified, features, consent, countersigned_at";

interface VendorRow {
	id: string;
	slug: string;
	name: string;
	domain: string;
	domain_verified_at?: string | null;
	proofs_published_at?: string | null;
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
	countersigned_at: string | null;
}

function toFixture(row: VendorRow, customers: CustomerRow[]): VendorFixture {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		domain: row.domain,
		category: row.category,
		key: row.key,
		domainVerified: Boolean(row.domain_verified_at),
		proofsPublishedAt: row.proofs_published_at ?? null,
		customers: customers.map((c) => ({
			slug: c.slug,
			name: c.name,
			domain: c.domain,
			since: c.since,
			tier: c.tier,
			verified: c.verified,
			features: c.features,
			consent: c.consent,
			countersignedAt: c.countersigned_at,
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

	const { data: rows } = await db.from("vendors").select(VENDOR_COLUMNS);
	if (!rows || rows.length === 0) return [];

	const { data: customerRows } = await db
		.from("vendor_customers")
		.select(VENDOR_CUSTOMER_COLUMNS)
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
		// The row itself, not a hand-copied subset: rebuilding the literal is
		// exactly how `domain_verified_at` got dropped from all three of these
		// call sites at once, silently capping every vendor at tier 0.
		toFixture(row, customersByVendor.get(row.id) ?? []),
	);
}

export async function findVendor(slug: string): Promise<VendorFixture | undefined> {
	const db = dbClient();
	if (!db) return undefined;

	const { data: row } = await db
		.from("vendors")
		.select(VENDOR_COLUMNS)
		.eq("slug", slug)
		.maybeSingle();
	if (!row) return undefined;

	const { data: customerRows } = await db
		.from("vendor_customers")
		.select(VENDOR_CUSTOMER_COLUMNS)
		.eq("vendor_id", row.id);

	return toFixture(row, (customerRows ?? []) as unknown as CustomerRow[]);
}

/**
 * Whether this vendor's proofs are public.
 *
 * The only way publication should ask, the same way `consentOf` is the only
 * way it should ask about a customer. A vendor is private until someone
 * publishes it, and absent means private for the same reason it does for
 * consent: the failure mode of guessing wrong is a signed, public, permanently
 * fetchable claim about a party who never agreed to make it.
 */
export function isPublished(vendor: VendorFixture): boolean {
	return vendor.proofsPublishedAt !== null;
}

/**
 * `findVendor`, gated — **the resolution point every public surface goes
 * through.**
 *
 * The two-function shape is deliberate and is copied from `customerChain` /
 * `customerProof` next door in attest/proofs.ts, which exists because the
 * consent rule had lived inside one function's body and only the route that
 * happened to call it was protected. The same trap is here: `findVendor` is
 * what the collector, the freeze, the countersigner and every vendor-scoped
 * tool call, and every one of them must keep working while a vendor is
 * private. So the gate is not inside `findVendor`; it is a second, differently
 * named door, and "which door am I calling" is answerable by reading the call
 * site.
 *
 * **Undefined, not a distinct "private" result.** Callers 404 on undefined
 * already, and an unpublished vendor must be indistinguishable from an unknown
 * one — exactly what the consent gate does for a withheld customer. A response
 * that said "this vendor exists but is private" would let anyone confirm, by
 * guessing slugs, that a company has installed Letterprove and not launched
 * yet. That is a commercial fact about someone else's roadmap, and it is not
 * ours to leak.
 */
export async function findPublishedVendor(slug: string): Promise<VendorFixture | undefined> {
	const vendor = await findVendor(slug);
	return vendor && isPublished(vendor) ? vendor : undefined;
}

/** `allVendors`, gated. For listings a stranger reads — the home page, discovery. */
export async function publishedVendors(): Promise<VendorFixture[]> {
	return (await allVendors()).filter(isPublished);
}

/**
 * Resolve a Letterstory organization to the vendor it is.
 *
 * A Letterprove vendor IS a Letterstory org, 1:1 (Steve, 2026-08-25) — related
 * records in two databases rather than one record in one. This is the only
 * function that crosses that line, and it crosses it by id alone: no join, no
 * knowledge of Letterstory's schema, nothing that would break when it changes.
 *
 * Returns undefined for an org that has no vendor yet. That is a real state
 * rather than an error: linking is deliberate, there is no auto-provisioning,
 * so a caller finding nothing should offer to create one rather than fail.
 *
 * The uniqueness that makes "the vendor" meaningful is a partial unique index,
 * not something enforced here. Two rows sharing an org would make this return
 * an arbitrary one of them, so the guarantee belongs in the schema where a
 * concurrent write can't slip past it.
 */
export async function findVendorByOrg(orgId: string): Promise<VendorFixture | undefined> {
	const db = dbClient();
	if (!db) return undefined;

	const { data: row } = await db
		.from("vendors")
		.select(VENDOR_COLUMNS)
		.eq("letterstory_org_id", orgId)
		.maybeSingle();
	if (!row) return undefined;

	const { data: customerRows } = await db
		.from("vendor_customers")
		.select(VENDOR_CUSTOMER_COLUMNS)
		.eq("vendor_id", row.id);

	return toFixture(row, (customerRows ?? []) as unknown as CustomerRow[]);
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
		.select(VENDOR_COLUMNS)
		.eq("key", key)
		.maybeSingle();
	if (!row) return undefined;

	const { data: customerRows } = await db
		.from("vendor_customers")
		.select(VENDOR_CUSTOMER_COLUMNS)
		.eq("vendor_id", row.id);

	return toFixture(row, (customerRows ?? []) as unknown as CustomerRow[]);
}

export function findCustomer(vendor: VendorFixture, slug: string): CustomerFixture | undefined {
	return vendor.customers.find((c) => c.slug === slug);
}
