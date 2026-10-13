import { dbClient } from "@/lib/db/client";
import { acceptedHosts } from "@/lib/vendors/hosts";
import { normalizeDomain } from "@/lib/vendors/domain";
import {
	isMaverickConfigured,
	isMaverickPartnerConfigured,
	listPeople,
	partnerCreateDomain,
	partnerDeleteDomain,
	profileIdFromSnippet,
	type MaverickPerson,
} from "@/lib/maverick/client";

/**
 * Visitor identification: who is visiting the vendor's own site, identified by
 * Maverick Intelligence through the pixel attest.js loads.
 *
 * A DIFFERENT DATA CLASS FROM EVERYTHING ELSE IN LETTERPROVE, and kept apart
 * on purpose. Collection (attest.js → /v1/observe) keeps only the domain of a
 * signed-in user's email, and is evidence. This keeps nothing at all: people
 * are pulled live from Maverick when the vendor asks and handed to the vendor,
 * never written to our database, never signed, never public. It is not
 * evidence either — a company visiting a site says nothing about whether it
 * is a customer — so nothing here ever reaches the attestation.
 *
 * TENANT ISOLATION is the load-bearing part, as in Letterstory's phantom
 * Visitors tab (src/lib/phantom-visitors/service.ts there), whose design this
 * follows. Our Maverick account is one PARTNER account holding every tracked
 * site, so a pull sees everyone's people. A record reaches a vendor only when
 * it was seen on that vendor's DNS-verified domain or one of its accepted
 * hosts, or carries the clientRef this feature stamped on the vendor's own
 * registration. Anything else is dropped. And the vendor has to be verified
 * at the moment of the read: identities for a domain nobody currently proves
 * are not handed to anyone.
 *
 * OPT-IN. Off until the vendor turns it on (set_visitor_identification).
 */

export type Tracking = "off" | "active" | "pending_registration";

export interface VisitorIdentificationStatus {
	enabled: boolean;
	tracking: Tracking;
	/** Hosts this feature registered with Maverick. */
	registered_domains: string[];
	message: string;
}

interface VisitorRow {
	domain: string;
	domain_verified_at: string | null;
	visitor_identification_enabled: boolean | null;
	maverick_customer_id: string | null;
	maverick_profile_id: string | null;
	maverick_domains: string[] | null;
}

const COLUMNS =
	"domain, domain_verified_at, visitor_identification_enabled, maverick_customer_id, maverick_profile_id, maverick_domains";

/** The clientRef stamped on registrations this feature makes, so pulled records attribute back. */
export function clientRefFor(vendorId: string): string {
	return `letterprove:${vendorId}`;
}

async function readRow(vendorId: string): Promise<VisitorRow | null> {
	const db = dbClient();
	if (!db) return null;
	const { data, error } = await db.from("vendors").select(COLUMNS).eq("id", vendorId).maybeSingle<VisitorRow>();
	return error ? null : data;
}

/** The pixel profile id: what Maverick's snippet said, else the account-wide one from env. */
function fallbackProfileId(): string | null {
	return process.env.MAVERICK_PIXEL_PROFILE_ID || null;
}

export function statusOf(row: Pick<VisitorRow, "visitor_identification_enabled" | "maverick_customer_id" | "maverick_profile_id" | "maverick_domains">): VisitorIdentificationStatus {
	const enabled = Boolean(row.visitor_identification_enabled);
	const registered = row.maverick_domains ?? [];
	if (!enabled) {
		return { enabled, tracking: "off", registered_domains: registered, message: "Visitor identification is off." };
	}
	if (row.maverick_customer_id && row.maverick_profile_id) {
		return {
			enabled,
			tracking: "active",
			registered_domains: registered,
			message: "On. Your Letterprove script now loads Maverick on your site, and visitors show up here as they are identified.",
		};
	}
	return {
		enabled,
		tracking: "pending_registration",
		registered_domains: registered,
		message: "On, but your domain isn't registered with Maverick yet, so nobody is being identified. Turning it on again retries.",
	};
}

/** The current state, for the read tool. Null when the vendor can't be read. */
export async function visitorIdentificationStatus(vendorId: string): Promise<VisitorIdentificationStatus | null> {
	const row = await readRow(vendorId);
	return row ? statusOf(row) : null;
}

export type SetResult =
	| { ok: true; status: VisitorIdentificationStatus }
	| { ok: false; error: "not_found" | "domain_not_verified" | "storage_unavailable"; detail: string };

type Deps = { create?: typeof partnerCreateDomain; remove?: typeof partnerDeleteDomain };

/**
 * Turn visitor identification on or off.
 *
 * On: needs a DNS-verified domain, then registers the verified domain and each
 * accepted host as a Maverick Tracked Domain and records the pixel ids. A
 * Maverick failure does not fail the call — the toggle is stored and reported
 * as pending_registration, and turning it on again retries.
 *
 * Off: deactivates ONLY the domains this feature registered. A domain the
 * partner account already tracked (one of our own marketing sites, say) comes
 * back `existing` with someone else's clientRef, is never recorded as ours,
 * and is never deactivated here.
 */
export async function setVisitorIdentification(vendorId: string, enabled: boolean, deps: Deps = {}): Promise<SetResult> {
	const db = dbClient();
	if (!db) return { ok: false, error: "storage_unavailable", detail: "Storage is unavailable." };
	const row = await readRow(vendorId);
	if (!row) return { ok: false, error: "not_found", detail: "Vendor not found." };
	const create = deps.create ?? partnerCreateDomain;
	const remove = deps.remove ?? partnerDeleteDomain;
	const ref = clientRefFor(vendorId);

	if (!enabled) {
		const kept: string[] = [];
		for (const domain of row.maverick_domains ?? []) {
			const res = await remove(domain);
			// "Unconfigured" means we can't reach Maverick at all; keep the domain
			// listed so the next off retries rather than forgetting it.
			if (!res.ok) kept.push(domain);
		}
		const update = {
			visitor_identification_enabled: false,
			maverick_customer_id: null,
			maverick_profile_id: null,
			maverick_domains: kept,
		};
		const { error } = await db.from("vendors").update(update).eq("id", vendorId);
		if (error) return { ok: false, error: "storage_unavailable", detail: "Couldn't save the setting." };
		return { ok: true, status: statusOf(update) };
	}

	if (!row.domain_verified_at) {
		return {
			ok: false,
			error: "domain_not_verified",
			detail: `Verify ${row.domain} with its DNS record first. Visitors are only identified on a domain you've proven is yours.`,
		};
	}

	let customerId = row.maverick_customer_id;
	let profileId = row.maverick_profile_id;
	const registered = new Set(row.maverick_domains ?? []);
	if (isMaverickPartnerConfigured()) {
		const hosts = [row.domain, ...(await acceptedHosts(vendorId))];
		for (const host of hosts) {
			const res = await create({ domain: host, clientRef: ref });
			if (!res.ok) {
				console.error(`[letterprove:visitors] tracked domain registration failed: ${res.message}`);
				continue;
			}
			customerId = res.data.customerId || customerId;
			profileId = profileIdFromSnippet(res.data.pixelSnippet) ?? profileId;
			if (!res.data.existing || res.data.clientRef === ref) registered.add(host);
		}
	}
	profileId = profileId ?? (customerId ? fallbackProfileId() : null);

	const update = {
		visitor_identification_enabled: true,
		maverick_customer_id: customerId,
		maverick_profile_id: customerId ? profileId : null,
		maverick_domains: [...registered].sort(),
	};
	const { error } = await db.from("vendors").update(update).eq("id", vendorId);
	if (error) return { ok: false, error: "storage_unavailable", detail: "Couldn't save the setting." };
	return { ok: true, status: statusOf(update) };
}

/** What /v1/config hands attest.js: the pixel ids, only while on and registered. */
export async function visitorPixel(vendorId: string): Promise<{ customer_id: string; profile_id: string } | null> {
	const row = await readRow(vendorId);
	if (!row?.visitor_identification_enabled || !row.domain_verified_at) return null;
	if (!row.maverick_customer_id || !row.maverick_profile_id) return null;
	return { customer_id: row.maverick_customer_id, profile_id: row.maverick_profile_id };
}

// ---------------------------------------------------------------- the read

export interface VisitorPerson {
	person_id: string;
	name: string | null;
	title: string | null;
	company: string | null;
	company_domain: string | null;
	/** Work address only. A personal address says nothing about the company. */
	email: string | null;
	linkedin_url: string | null;
	location: string | null;
	seniority: string | null;
	job_function: string | null;
	visit_count: number;
	first_seen: string;
	last_seen: string;
	/** The host the person was seen on. */
	seen_on: string | null;
}

export interface VisitorCompany {
	company: string | null;
	domain: string | null;
	people: number;
	visits: number;
	last_seen: string;
}

const norm = (v: string | null | undefined) => normalizeDomain(v ?? "") ?? (v ?? "").trim().toLowerCase();

/**
 * Pure: keep only people seen on one of `hosts` or stamped with `clientRef`,
 * last seen at or after `since`. Exported for the unit test, because this
 * function is the whole tenant boundary.
 */
export function attributeVisitors(people: MaverickPerson[], hosts: Set<string>, clientRef: string, since: string): VisitorPerson[] {
	const wanted = new Set([...hosts].map((h) => norm(h)));
	const seen = new Set<string>();
	const rows: VisitorPerson[] = [];
	for (const p of people) {
		if (seen.has(p.id)) continue;
		const onHost = p.domain ? wanted.has(norm(p.domain)) : false;
		if (!onHost && p.clientRef !== clientRef) continue;
		if (!p.lastSeen || p.lastSeen < since) continue;
		seen.add(p.id);
		rows.push({
			person_id: p.id,
			name: [p.firstName, p.lastName].filter(Boolean).join(" ") || null,
			title: p.title ?? null,
			company: p.company ?? p.companyData?.name ?? null,
			company_domain: p.companyData?.domain ? norm(p.companyData.domain) : null,
			email: p.businessEmail ?? null,
			linkedin_url: p.linkedinUrl ?? null,
			location: p.location ?? null,
			seniority: p.classifiedSeniority ?? null,
			job_function: p.classifiedJobFunction ?? null,
			visit_count: p.visitCount ?? 0,
			first_seen: p.firstSeen,
			last_seen: p.lastSeen,
			seen_on: p.domain ? norm(p.domain) : null,
		});
	}
	rows.sort((a, b) => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0));
	return rows;
}

/** Pure: one row per company, busiest first. People with no company are grouped under null. */
export function rollupCompanies(people: VisitorPerson[]): VisitorCompany[] {
	const by = new Map<string, VisitorCompany>();
	for (const p of people) {
		const key = p.company_domain ?? (p.company ? `name:${p.company.toLowerCase()}` : "");
		const prev = by.get(key);
		if (prev) {
			prev.people += 1;
			prev.visits += p.visit_count;
			if (p.last_seen > prev.last_seen) prev.last_seen = p.last_seen;
			prev.company = prev.company ?? p.company;
		} else {
			by.set(key, { company: p.company, domain: p.company_domain, people: 1, visits: p.visit_count, last_seen: p.last_seen });
		}
	}
	return [...by.values()].sort((a, b) => b.people - a.people || b.visits - a.visits || (a.last_seen < b.last_seen ? 1 : -1));
}

export interface VisitorsResult {
	enabled: boolean;
	tracking: Tracking;
	/** Whether this deployment can read from Maverick at all. */
	configured: boolean;
	window_days: number;
	error: { reason: "forbidden" | "failed"; message: string } | null;
	companies: VisitorCompany[];
	visitors: VisitorPerson[];
	/** Identified people in the window before `limit` applied. */
	total: number;
}

/** Newest-first pages of 100. The account limit is 1,000 requests an hour, shared with Letterstory. */
const MAX_PAGES = 3;
const PAGE_SIZE = 100;
/** A dashboard refresh must not spend the shared rate limit; five minutes is fresh enough. */
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; people: MaverickPerson[]; error: VisitorsResult["error"] }>();

export function _resetVisitorCache(): void {
	cache.clear();
}

async function pull(opts: { clientRef?: string; since: string }, list: typeof listPeople) {
	const people: MaverickPerson[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = await list({ limit: PAGE_SIZE, cursor, since: opts.since, clientRef: opts.clientRef });
		if (!res.ok) {
			return { people, error: res.reason === "unconfigured" ? null : { reason: res.reason, message: res.message } };
		}
		people.push(...res.data.data);
		cursor = res.data.pagination?.nextCursor ?? undefined;
		if (!cursor) break;
	}
	return { people, error: null };
}

/**
 * Identified visitors on the vendor's own site over the last `days`, plus a
 * company rollup. Pulled live; nothing is stored.
 */
export async function fetchVendorVisitors(
	vendorId: string,
	opts: { limit?: number; days?: number } = {},
	list: typeof listPeople = listPeople,
): Promise<VisitorsResult | null> {
	const row = await readRow(vendorId);
	if (!row) return null;
	const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 90);
	const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
	const status = statusOf(row);
	const empty: VisitorsResult = {
		enabled: status.enabled,
		tracking: status.tracking,
		configured: isMaverickConfigured(),
		window_days: days,
		error: null,
		companies: [],
		visitors: [],
		total: 0,
	};
	// Off, or not currently proven: nothing is handed over.
	if (!status.enabled || !row.domain_verified_at) return empty;
	if (!isMaverickConfigured()) return empty;

	const since = new Date(Date.now() - days * 86_400_000).toISOString();
	const hosts = new Set([row.domain, ...(await acceptedHosts(vendorId))].map((h) => norm(h)));
	const ref = clientRefFor(vendorId);

	const cacheKey = `${vendorId}/${days}`;
	let hit = cache.get(cacheKey);
	if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
		// Our own registrations carry our clientRef, so one filtered pull finds
		// them. A host that was tracked before we registered it keeps its
		// original clientRef, so it can only be found by scanning the account
		// and matching on the host.
		const ours = new Set(row.maverick_domains ?? []);
		const needsScan = [...hosts].some((h) => !ours.has(h));
		const byRef = await pull({ clientRef: ref, since }, list);
		const scan = needsScan ? await pull({ since }, list) : { people: [], error: null };
		hit = { at: Date.now(), people: [...byRef.people, ...scan.people], error: byRef.error ?? scan.error };
		if (!hit.error) cache.set(cacheKey, hit);
	}

	const attributed = attributeVisitors(hit.people, hosts, ref, since);
	return {
		...empty,
		error: hit.error,
		companies: rollupCompanies(attributed),
		visitors: attributed.slice(0, limit),
		total: attributed.length,
	};
}
