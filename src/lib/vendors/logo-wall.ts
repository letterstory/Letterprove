/**
 * Logo verification: which of the companies a vendor ALREADY shows on its own
 * public logo wall Letterprove has actually observed.
 *
 * THE ONE EXCEPTION TO "NO CUSTOMER IS NAMED" (README decision 36). It is
 * opt-in, and it can only name a company the vendor has already named in
 * public, on its own site:
 *
 *   1. The vendor lists companies and the page they appear on. The page must
 *      be on the vendor's verified domain, a host beneath it, or an accepted
 *      extra host, so it is a page the vendor provably controls.
 *   2. Letterprove fetches that page and keeps, per company, whether its name
 *      or domain actually appears there. A company that is not on the page is
 *      never named, whatever the vendor typed.
 *   3. A company on the page is named only when Letterprove has evidence for
 *      it: observed signing in over the window ("active"), or that plus a
 *      settled invoice in the bound Stripe account ("paying"). Everyone else
 *      is a count.
 *
 * So the worst a vendor can do is list fewer logos than its page shows, which
 * only makes "X of Y verified" look better by shrinking Y. The page is linked
 * from the attestation, so a reader can count the logos themselves.
 */

import { dbClient } from "@/lib/db/client";
import { readAllRows } from "@/lib/db/read-all";
import { classifyDomain } from "@/lib/identity/domains";
import { normalizeDomain } from "@/lib/vendors/domain";
import { acceptedHosts, isOriginAccepted } from "@/lib/vendors/hosts";
import { checkDomainVerification, type TxtResolver } from "@/lib/vendors/verification";
import { registrableDomain } from "@/lib/vendors/custom-domain";

export const MAX_LOGOS = 200;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
/** Older checks read as absent on the proof: one missed daily run plus slack. */
export const MAX_CHECK_AGE_MS = 48 * 60 * 60 * 1000;

export type LogoStatus = "paying" | "active" | "not_observed";

export interface LogoEntry {
	name: string;
	domain: string;
	on_page: boolean;
}

export interface LogoWallRow {
	page_url: string;
	companies: LogoEntry[];
	checked_at: string | null;
	check_error: string | null;
}

// ---------------------------------------------------------------- input

export type LogoInputError = { error: string; detail: string };

/** Validate and normalize what a vendor submits. Pure. */
export function parseLogoWallInput(
	input: { page_url?: unknown; companies?: unknown },
	vendorDomain: string,
	extraHosts: ReadonlySet<string>,
	/** Other registrable domains this vendor proved with its own TXT record (see provenLogoDomain). */
	provenDomains: ReadonlySet<string> = new Set(),
): { ok: true; pageUrl: string; companies: { name: string; domain: string }[] } | ({ ok: false } & LogoInputError) {
	let url: URL;
	try {
		url = new URL(String(input.page_url ?? ""));
	} catch {
		return { ok: false, error: "invalid_page_url", detail: "page_url must be a full https URL, like https://yourcompany.com/customers." };
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) {
		return { ok: false, error: "invalid_page_url", detail: "page_url must be a plain https URL." };
	}
	const host = url.hostname.toLowerCase();
	const proven = [...provenDomains].some((d) => host === d || host.endsWith(`.${d}`));
	if (!isOriginAccepted(host, vendorDomain, extraHosts) && !proven) {
		return {
			ok: false,
			error: "page_not_yours",
			detail: `The logo wall has to be on ${vendorDomain}, a host under it, one of your accepted hosts, or a domain that carries your Letterprove TXT record.`,
		};
	}
	url.hash = "";

	if (!Array.isArray(input.companies) || input.companies.length === 0) {
		return { ok: false, error: "invalid_companies", detail: "companies must list at least one { name, domain }." };
	}
	if (input.companies.length > MAX_LOGOS) {
		return { ok: false, error: "too_many_companies", detail: `At most ${MAX_LOGOS} companies.` };
	}
	const seen = new Set<string>();
	const companies: { name: string; domain: string }[] = [];
	for (const raw of input.companies) {
		const r = (raw ?? {}) as { name?: unknown; domain?: unknown };
		const name = typeof r.name === "string" ? r.name.trim().slice(0, 120) : "";
		const domain = normalizeDomain(typeof r.domain === "string" ? r.domain : null);
		if (!name || !domain) {
			return { ok: false, error: "invalid_companies", detail: "Every company needs a name and a domain, like { name: \"Acme\", domain: \"acme.com\" }." };
		}
		const kind = classifyDomain(domain, vendorDomain).kind;
		if (kind !== "company") {
			return { ok: false, error: "not_a_company", detail: `${domain} can't be a logo: it isn't a company domain (free mail, ours, or malformed).` };
		}
		if (seen.has(domain)) continue;
		seen.add(domain);
		companies.push({ name, domain });
	}
	return { ok: true, pageUrl: url.toString(), companies };
}

// ---------------------------------------------------------------- the page

type Fetcher = typeof fetch;

/**
 * Fetch the logo page. Follows at most three redirects, and only within the
 * same registrable domain: a redirect off the vendor's domain is someone
 * else's page, and matching names on it would prove nothing.
 */
export async function fetchLogoPage(
	pageUrl: string,
	fetcher: Fetcher = fetch,
	/** Checked before every hop, redirects included; a non-null answer refuses the fetch (SSRF guard). */
	beforeFetch?: (url: URL) => Promise<string | null>,
): Promise<{ ok: true; html: string } | { ok: false; detail: string }> {
	const base = registrableDomain(new URL(pageUrl).hostname.toLowerCase());
	let current = pageUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (beforeFetch) {
			const refused = await beforeFetch(new URL(current));
			if (refused) return { ok: false, detail: refused };
		}
		let res: Response;
		try {
			res = await fetcher(current, {
				redirect: "manual",
				headers: { "user-agent": "Letterprove-LogoCheck/1.0 (+https://app.letterprove.com)", accept: "text/html" },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (e) {
			return { ok: false, detail: `Couldn't load ${current}: ${e instanceof Error ? e.message : String(e)}` };
		}
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) return { ok: false, detail: `${current} redirected without a location.` };
			const next = new URL(location, current);
			if (next.protocol !== "https:" || registrableDomain(next.hostname.toLowerCase()) !== base) {
				return { ok: false, detail: `${current} redirects off ${base}, so it can't be checked as your page.` };
			}
			current = next.toString();
			continue;
		}
		if (!res.ok) return { ok: false, detail: `${current} answered ${res.status}.` };
		const text = await readCapped(res);
		if (text === null) return { ok: false, detail: `${current} is larger than ${MAX_PAGE_BYTES / 1024 / 1024} MB.` };
		return { ok: true, html: text };
	}
	return { ok: false, detail: `${pageUrl} redirects more than ${MAX_REDIRECTS} times.` };
}

async function readCapped(res: Response): Promise<string | null> {
	if (!res.body) return (await res.text()).slice(0, MAX_PAGE_BYTES);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_PAGE_BYTES) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

const ATTR = /\b(?:alt|title|src|href|srcset|aria-label|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi;

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, " ");
}

/**
 * Which companies appear on the page. Pure. A company counts as on the page
 * when its domain appears anywhere in the HTML, or its name appears in the
 * visible text or in an alt/title/src/href attribute (case-insensitive, on
 * word boundaries), or the domain's own label (credal for credal.ai, at least
 * four characters) appears in an attribute, which is how most logo images are
 * named.
 */
export function matchOnPage(html: string, companies: { name: string; domain: string }[]): Set<string> {
	const lower = html.toLowerCase();
	const attrs: string[] = [];
	for (const m of lower.matchAll(ATTR)) attrs.push(decodeEntities(m[2] ?? m[3] ?? ""));
	const attrText = attrs.join(" \n ");
	const text = decodeEntities(
		lower
			.replace(/<script[\s\S]*?<\/script>/g, " ")
			.replace(/<style[\s\S]*?<\/style>/g, " ")
			.replace(/<[^>]+>/g, " "),
	);
	const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const word = (needle: string) => new RegExp(`(^|[^a-z0-9])${escape(needle)}($|[^a-z0-9])`);

	const found = new Set<string>();
	for (const c of companies) {
		const domain = c.domain.toLowerCase();
		const name = c.name.toLowerCase();
		const label = domain.split(".")[0];
		if (lower.includes(domain)) found.add(c.domain);
		else if (name.length >= 2 && (word(name).test(text) || word(name).test(attrText))) found.add(c.domain);
		else if (label.length >= 4 && word(label).test(attrText)) found.add(c.domain);
	}
	return found;
}

// ---------------------------------------------------------------- storage

/** The stored wall, or null when there is none or it can't be read: an unread wall names nobody. */
export async function readLogoWall(vendorId: string): Promise<LogoWallRow | null> {
	const db = dbClient();
	if (!db) return null;
	let data: { page_url: string; companies: unknown; checked_at: string | null; check_error: string | null } | null;
	try {
		const res = await db
			.from("vendor_logo_wall")
			.select("page_url, companies, checked_at, check_error")
			.eq("vendor_id", vendorId)
			.maybeSingle<{ page_url: string; companies: unknown; checked_at: string | null; check_error: string | null }>();
		data = res?.error ? null : (res?.data ?? null);
	} catch {
		return null;
	}
	if (!data) return null;
	const companies = Array.isArray(data.companies)
		? (data.companies as LogoEntry[]).filter((c) => c && typeof c.name === "string" && typeof c.domain === "string")
		: [];
	return { page_url: data.page_url, companies: companies.map((c) => ({ ...c, on_page: Boolean(c.on_page) })), checked_at: data.checked_at, check_error: data.check_error };
}

/** Store the vendor's list, then check the page once. A failed check is recorded, not fatal. */
export async function saveLogoWall(
	vendorId: string,
	pageUrl: string,
	companies: { name: string; domain: string }[],
	fetcher: Fetcher = fetch,
): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;
	const { error } = await db.from("vendor_logo_wall").upsert(
		{
			vendor_id: vendorId,
			page_url: pageUrl,
			companies: companies.map((c) => ({ ...c, on_page: false })),
			checked_at: null,
			check_error: null,
			updated_at: new Date().toISOString(),
		},
		{ onConflict: "vendor_id" },
	);
	if (error) return false;
	await checkLogoWall(vendorId, fetcher);
	return true;
}

/** Fetch the page and record which listed companies are on it. */
export async function checkLogoWall(vendorId: string, fetcher: Fetcher = fetch): Promise<{ ok: boolean; detail?: string }> {
	const db = dbClient();
	const wall = await readLogoWall(vendorId);
	if (!db || !wall) return { ok: false, detail: "No logo wall set." };
	// A page on another domain stays only while that domain still carries the
	// vendor's TXT record: the proof of control is re-checked with every read.
	const control = await pageControl(vendorId, wall.page_url);
	if (!control.ok) {
		await db.from("vendor_logo_wall").update({ check_error: control.detail }).eq("vendor_id", vendorId);
		return { ok: false, detail: control.detail };
	}
	const page = await fetchLogoPage(wall.page_url, fetcher);
	if (!page.ok) {
		await db.from("vendor_logo_wall").update({ check_error: page.detail }).eq("vendor_id", vendorId);
		return { ok: false, detail: page.detail };
	}
	const found = matchOnPage(page.html, wall.companies);
	await db
		.from("vendor_logo_wall")
		.update({
			companies: wall.companies.map((c) => ({ name: c.name, domain: c.domain, on_page: found.has(c.domain) })),
			checked_at: new Date().toISOString(),
			check_error: null,
		})
		.eq("vendor_id", vendorId);
	return { ok: true };
}

export async function clearLogoWall(vendorId: string): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;
	const { error } = await db.from("vendor_logo_wall").delete().eq("vendor_id", vendorId);
	return !error;
}

/** Daily re-check of every vendor's logo page, each failure named. */
export async function recheckAllLogoWalls(fetcher: Fetcher = fetch): Promise<{ checked: number; errors: { vendorId: string; detail: string }[] }> {
	const db = dbClient();
	if (!db) return { checked: 0, errors: [] };
	const rows = await readAllRows<{ vendor_id: string }>("vendors with a logo wall", (from, to) =>
		db.from("vendor_logo_wall").select("vendor_id").order("vendor_id", { ascending: true }).range(from, to),
	);
	const errors: { vendorId: string; detail: string }[] = [];
	for (const { vendor_id } of rows) {
		try {
			const r = await checkLogoWall(vendor_id, fetcher);
			if (!r.ok) errors.push({ vendorId: vendor_id, detail: r.detail ?? "check failed" });
		} catch (e) {
			errors.push({ vendorId: vendor_id, detail: `threw: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
	return { checked: rows.length, errors };
}

// ---------------------------------------------------------------- status

/** Status per listed company from the observed and paying domain sets. Pure. */
/**
 * "paying" on a settled invoice in the vendor's bound Stripe, whether or not
 * the company signed in (managed accounts pay without logging in); else
 * "active" when Letterprove observed it signing in; else "not_observed".
 */
export function statusOf(domain: string, observed: ReadonlySet<string>, paying: ReadonlySet<string>): LogoStatus {
	if (paying.has(domain)) return "paying";
	return observed.has(domain) ? "active" : "not_observed";
}

export interface PublicLogos {
	page: string;
	listed: number;
	on_page: number;
	verified: number;
	/** Of `verified`, how many pay through the bound Stripe / were only observed signing in. */
	paying: number;
	active: number;
	/** Absent when the vendor chose to show counts only (display `logo_names: false`). */
	companies?: { name: string; domain: string; status: "paying" | "active" }[];
}

/**
 * The attestation's `logos` block. Pure. Names ONLY companies that are on the
 * vendor's page and either observed signing in or paying through its bound
 * Stripe; everything else is a count. Null when there
 * is nothing checked recently enough to sign.
 */
export function publicLogos(
	wall: LogoWallRow | null,
	observed: ReadonlySet<string>,
	paying: ReadonlySet<string>,
	now = Date.now(),
): PublicLogos | null {
	if (!wall || !wall.checked_at) return null;
	if (now - Date.parse(wall.checked_at) > MAX_CHECK_AGE_MS) return null;
	const onPage = wall.companies.filter((c) => c.on_page);
	const verified = onPage
		.map((c) => ({ name: c.name, domain: c.domain, status: statusOf(c.domain, observed, paying) }))
		.filter((c): c is { name: string; domain: string; status: "paying" | "active" } => c.status !== "not_observed")
		.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "paying" ? -1 : 1));
	return {
		page: wall.page_url,
		listed: wall.companies.length,
		on_page: onPage.length,
		verified: verified.length,
		paying: verified.filter((c) => c.status === "paying").length,
		active: verified.filter((c) => c.status === "active").length,
		companies: verified,
	};
}


/**
 * A logo wall may sit on a domain other than the verified one (Letter's is on
 * letter.dev; its product runs on letterstory.com) when that domain carries
 * the vendor's own Letterprove TXT record — the same proof of control the
 * verified domain needed. Returns the registrable domain when proven.
 */
export async function provenLogoDomain(host: string, token: string | null, resolver?: TxtResolver): Promise<string | null> {
	if (!token) return null;
	const base = registrableDomain(host);
	const outcome = await checkDomainVerification(base, token, resolver);
	return outcome.verified ? base : null;
}

/** Whether the vendor still controls the page's host. */
async function pageControl(vendorId: string, pageUrl: string): Promise<{ ok: true } | { ok: false; detail: string }> {
	const db = dbClient();
	if (!db) return { ok: false, detail: "No datastore configured." };
	let host: string;
	try {
		host = new URL(pageUrl).hostname.toLowerCase();
	} catch {
		return { ok: false, detail: "The page URL is not valid." };
	}
	const { data: vendor } = await db
		.from("vendors")
		.select("domain, domain_verification_token")
		.eq("id", vendorId)
		.maybeSingle<{ domain: string; domain_verification_token: string | null }>();
	if (!vendor) return { ok: false, detail: "Vendor not found." };
	if (isOriginAccepted(host, vendor.domain, await acceptedHosts(vendorId))) return { ok: true };
	if (await provenLogoDomain(host, vendor.domain_verification_token)) return { ok: true };
	return { ok: false, detail: `${registrableDomain(host)} no longer carries your Letterprove TXT record.` };
}
