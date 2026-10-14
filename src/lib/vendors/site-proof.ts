import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { after } from "next/server";
import { dbClient } from "@/lib/db/client";
import { normalizeDomain } from "@/lib/vendors/domain";
import { fetchLogoPage } from "@/lib/vendors/logo-wall";
import type { DomainProof } from "@/lib/attest/domain-proof";

/**
 * Site proof: the middle of the three domain states a proof can carry.
 *
 *   none — nothing proven. The vendor named a domain; its counts are its claim.
 *   site — Letterprove fetched a page the vendor named, on that domain, and
 *          found attest.js carrying the vendor's current key in a <script> tag.
 *   dns  — the vendor published our TXT record (lib/vendors/verification.ts).
 *
 * WHY SITE PROOF IS WORTH SOMETHING. The publishable key ships in page HTML by
 * design, so seeing it is not a secret handshake. What it proves is that
 * whoever controls the HTML served at https://app.acme.com/login put OUR script
 * with THIS vendor's key there. An impersonator who registered "acme.com" can't
 * do that. Browser sign-ins pinned to that origin (the Origin header a browser
 * can't forge) are then the vendor's own users, which is the sentence tier 1
 * rests on.
 *
 * WHY IT IS WEAKER THAN DNS. It proves control of a page, not of the domain's
 * DNS: one team, one CMS login, or one compromised page can carry the tag. It
 * says nothing about sibling hosts. So site proof earns tier 1 at most; the
 * Stripe binding (an account matched to the domain), the logo wall and tier 3
 * still need DNS.
 *
 * The config ping (`Origin: app.acme.com`) is NOT proof: any server can send
 * that header. The check is ours: we fetch the page.
 *
 * WHAT COUNTS. A <script> whose src is app.letterprove.com/attest.js and whose
 * data-key is exactly the vendor's current key, in the HTML of an https page
 * whose host is the vendor's domain or a host beneath it. Redirects are
 * followed only within the registrable domain (fetchLogoPage), each hop
 * re-checked against the SSRF guard. A tag injected by a tag manager isn't in
 * the HTML and doesn't count; DNS is the way for those sites.
 *
 * KEPT CURRENT like DNS (lib/vendors/dns-recheck.ts): the daily re-check
 * re-fetches site_verified_url, and three answered misses over two days clear
 * site_verified_at. A page we couldn't load (timeout, DNS, TLS) isn't a miss.
 */

export const ATTEST_SRC = "app.letterprove.com/attest.js";
export const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const MISSES_TO_CLEAR = 3;
export const MIN_FAILING_MS = 48 * 60 * 60 * 1000;

type Fetcher = typeof fetch;
export type Lookup = (host: string) => Promise<string[]>;

const liveLookup: Lookup = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** Pure: the strongest proof a vendor ROW carries (snake_case columns). DNS wins over site. */
export function rowDomainProof(row: { domain_verified_at?: string | null; site_verified_at?: string | null }): DomainProof {
	if (row.domain_verified_at) return "dns";
	if (row.site_verified_at) return "site";
	return "none";
}

/** Pure: does this HTML carry `key` in an attest.js script tag? */
export function htmlHasAttestKey(html: string, key: string): boolean {
	for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
		const attrs = m[1];
		const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
		const dataKey = /\bdata-key\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
		const normalizedSrc = src.replace(/^(https?:)?\/\//i, "").split(/[?#]/)[0].toLowerCase();
		if (dataKey === key && normalizedSrc === ATTEST_SRC) return true;
	}
	return false;
}

export type SiteUrlCheck = { ok: true; url: string; host: string } | { ok: false; error: "invalid_url" | "not_https" | "not_your_domain"; detail: string };

/** Pure: the page must be https and on the vendor's domain (the domain itself or a host beneath it). */
export function normalizeSiteUrl(input: string, vendorDomain: string): SiteUrlCheck {
	let u: URL;
	try {
		u = new URL(input.includes("://") ? input : `https://${input}`);
	} catch {
		return { ok: false, error: "invalid_url", detail: `"${input}" isn't a URL. Use something like https://app.${vendorDomain}/login.` };
	}
	if (u.protocol !== "https:") return { ok: false, error: "not_https", detail: "The page must be https." };
	if (u.username || u.password || (u.port && u.port !== "443")) {
		return { ok: false, error: "invalid_url", detail: "Use a plain https URL with no credentials or port." };
	}
	const host = normalizeDomain(u.hostname);
	if (!host || (host !== vendorDomain && !host.endsWith(`.${vendorDomain}`))) {
		return { ok: false, error: "not_your_domain", detail: `The page must be on ${vendorDomain} or a host beneath it.` };
	}
	u.hash = "";
	return { ok: true, url: u.toString(), host };
}

const PRIVATE_V4 = [
	/^0\./,
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Pure: an address we must never fetch from a vendor-supplied name. */
export function isPrivateAddress(addr: string): boolean {
	const a = addr.toLowerCase();
	if (isIP(a) === 4) return PRIVATE_V4.some((r) => r.test(a));
	if (a === "::1" || a === "::") return true;
	if (a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80")) return true;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
	return mapped ? isPrivateAddress(mapped[1]) : false;
}

async function publicHostRefusal(host: string, lookup: Lookup): Promise<string | null> {
	if (isIP(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || !host.includes(".")) {
		return `${host} isn't a public hostname.`;
	}
	let addrs: string[];
	try {
		addrs = await lookup(host);
	} catch {
		return `${host} doesn't resolve.`;
	}
	if (addrs.length === 0) return `${host} doesn't resolve.`;
	if (addrs.some(isPrivateAddress)) return `${host} resolves to a private address.`;
	return null;
}

export interface SiteCheck {
	verified: boolean;
	checked_url: string;
	reason: string;
	/** True when the page answered but the key wasn't on it (a real miss, for the re-check). */
	answered: boolean;
}

/** Look for the key on one page. Never throws, never writes. */
export async function checkSitePage(url: string, key: string, deps: { fetcher?: Fetcher; lookup?: Lookup } = {}): Promise<SiteCheck> {
	const lookup = deps.lookup ?? liveLookup;
	let page: Awaited<ReturnType<typeof fetchLogoPage>>;
	try {
		page = await fetchLogoPage(url, deps.fetcher ?? fetch, (u) => publicHostRefusal(u.hostname.toLowerCase(), lookup));
	} catch (e) {
		return { verified: false, checked_url: url, reason: `Couldn't load ${url}: ${e instanceof Error ? e.message : String(e)}`, answered: false };
	}
	if (!page.ok) {
		// An HTTP answer (404, a redirect off the domain) is the site speaking; a
		// thrown fetch or a refused host is us failing to ask.
		const answered = !page.detail.startsWith("Couldn't load") && !/isn't a public hostname|doesn't resolve|private address/.test(page.detail);
		return { verified: false, checked_url: url, reason: page.detail, answered };
	}
	if (htmlHasAttestKey(page.html, key)) {
		return { verified: true, checked_url: url, reason: `Found your Letterprove script on ${url}.`, answered: true };
	}
	return {
		verified: false,
		checked_url: url,
		reason: `Your Letterprove script (attest.js with your key) isn't in the HTML of ${url}. A tag manager can't be checked; use the DNS record instead.`,
		answered: true,
	};
}

interface SiteRow {
	domain: string;
	key: string;
	domain_verified_at: string | null;
	site_verified_at: string | null;
	site_verified_url: string | null;
	site_checked_at: string | null;
	site_check_failures: number | null;
	site_failing_since: string | null;
}

const SITE_COLUMNS = "domain, key, domain_verified_at, site_verified_at, site_verified_url, site_checked_at, site_check_failures, site_failing_since";

export type VerifySiteResult =
	| {
			ok: true;
			verified: boolean;
			domain_proof: DomainProof;
			checked_url: string;
			reason: string;
			site_verified_at: string | null;
			site_verified_url: string | null;
	  }
	| { ok: false; error: "not_found" | "storage_unavailable" | "invalid_url" | "not_https" | "not_your_domain"; detail: string };

/**
 * Check a page now and record the result. `url` defaults to the page that
 * last verified, else https://<domain>/. A failed check never clears an
 * existing proof; only the daily re-check's three-misses rule does.
 */
export async function verifySite(vendorId: string, url?: string | null, deps: { fetcher?: Fetcher; lookup?: Lookup } = {}): Promise<VerifySiteResult> {
	const db = dbClient();
	if (!db) return { ok: false, error: "storage_unavailable", detail: "Storage is unavailable." };
	const { data: row } = await db.from("vendors").select(SITE_COLUMNS).eq("id", vendorId).maybeSingle<SiteRow>();
	if (!row) return { ok: false, error: "not_found", detail: "Vendor not found." };
	const target = normalizeSiteUrl(url?.trim() || row.site_verified_url || `https://${row.domain}/`, row.domain);
	if (!target.ok) return { ok: false, error: target.error, detail: target.detail };

	const now = new Date().toISOString();
	const check = await checkSitePage(target.url, row.key, deps);
	if (check.verified) {
		const verifiedAt = row.site_verified_at ?? now;
		await db
			.from("vendors")
			.update({ site_verified_at: verifiedAt, site_verified_url: target.url, site_checked_at: now, site_check_failures: 0, site_failing_since: null })
			.eq("id", vendorId)
			.eq("domain", row.domain);
		return {
			ok: true,
			verified: true,
			domain_proof: rowDomainProof({ domain_verified_at: row.domain_verified_at, site_verified_at: verifiedAt }),
			checked_url: target.url,
			reason: check.reason,
			site_verified_at: verifiedAt,
			site_verified_url: target.url,
		};
	}
	await db.from("vendors").update({ site_checked_at: now }).eq("id", vendorId);
	return {
		ok: true,
		verified: Boolean(row.site_verified_at),
		domain_proof: rowDomainProof(row),
		checked_url: target.url,
		reason: check.reason,
		site_verified_at: row.site_verified_at,
		site_verified_url: row.site_verified_url,
	};
}

/**
 * The page to try when attest.js pings /v1/config: the Referer when it is a
 * full page URL on the vendor's domain, else https://<origin host>/. Null when
 * neither is on the domain. Pure.
 */
export function autoCheckUrl(origin: string | null, referer: string | null, vendorDomain: string): string | null {
	if (referer) {
		const r = normalizeSiteUrl(referer, vendorDomain);
		if (r.ok) return r.url;
	}
	if (origin) {
		let host: string;
		try {
			host = new URL(origin).hostname;
		} catch {
			return null;
		}
		const o = normalizeSiteUrl(`https://${host}/`, vendorDomain);
		if (o.ok) return o.url;
	}
	return null;
}

/** From /v1/config: try the page once every ten minutes until site- or DNS-verified. */
export async function maybeAutoVerifySite(vendorId: string, pageUrl: string): Promise<void> {
	const db = dbClient();
	if (!db) return;
	const { data } = await db
		.from("vendors")
		.select("domain_verified_at, site_verified_at, site_checked_at")
		.eq("id", vendorId)
		.maybeSingle<{ domain_verified_at: string | null; site_verified_at: string | null; site_checked_at: string | null }>();
	if (!data || data.domain_verified_at || data.site_verified_at) return;
	if (data.site_checked_at && Date.now() - new Date(data.site_checked_at).getTime() < AUTO_CHECK_INTERVAL_MS) return;
	await verifySite(vendorId, pageUrl);
}

/** Run maybeAutoVerifySite after the current response is sent. Never throws. */
export function scheduleSiteAutoVerify(vendorId: string, pageUrl: string): void {
	try {
		after(() =>
			maybeAutoVerifySite(vendorId, pageUrl).catch((e) => console.error(`[letterprove:site-proof] ${e instanceof Error ? e.message : String(e)}`)),
		);
	} catch (e) {
		// Outside a request scope (a script, a test): skip; the next ping retries.
		console.error(`[letterprove:site-proof] not scheduled: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ---------------------------------------------------------------- daily re-check

export interface SiteRecheckState {
	site_check_failures: number;
	site_failing_since: string | null;
}

/** Pure: what one daily re-check does to the row (same rule as DNS). */
export function decideSiteRecheck(prev: SiteRecheckState, check: SiteCheck, now: Date): { patch: Record<string, unknown>; cleared: boolean } {
	const checkedAt = now.toISOString();
	if (check.verified) return { cleared: false, patch: { site_checked_at: checkedAt, site_check_failures: 0, site_failing_since: null } };
	if (!check.answered) return { cleared: false, patch: { site_checked_at: checkedAt } };
	const failures = prev.site_check_failures + 1;
	const failingSince = prev.site_failing_since ?? checkedAt;
	const cleared = failures >= MISSES_TO_CLEAR && now.getTime() - new Date(failingSince).getTime() >= MIN_FAILING_MS;
	return {
		cleared,
		patch: {
			site_checked_at: checkedAt,
			site_check_failures: failures,
			site_failing_since: failingSince,
			...(cleared ? { site_verified_at: null } : {}),
		},
	};
}

/** Re-check every site-verified vendor that has no DNS proof. Never throws. */
export async function recheckAllSites(
	deps: { fetcher?: Fetcher; lookup?: Lookup; now?: () => Date } = {},
): Promise<{ checked: number; cleared: string[]; errors: { slug: string; detail: string }[] }> {
	const out = { checked: 0, cleared: [] as string[], errors: [] as { slug: string; detail: string }[] };
	const db = dbClient();
	if (!db) return out;
	const { data, error } = await db
		.from("vendors")
		.select(`id, slug, ${SITE_COLUMNS}`)
		.not("site_verified_at", "is", null)
		.is("domain_verified_at", null);
	if (error) {
		out.errors.push({ slug: "*", detail: error.message });
		return out;
	}
	for (const v of (data ?? []) as (SiteRow & { id: string; slug: string })[]) {
		try {
			const target = normalizeSiteUrl(v.site_verified_url ?? `https://${v.domain}/`, v.domain);
			// The domain changed under a stored URL: that proof covers nothing now.
			const check: SiteCheck = target.ok
				? await checkSitePage(target.url, v.key, deps)
				: { verified: false, checked_url: v.site_verified_url ?? "", reason: target.detail, answered: true };
			const decision = decideSiteRecheck(
				{ site_check_failures: v.site_check_failures ?? 0, site_failing_since: v.site_failing_since },
				check,
				(deps.now ?? (() => new Date()))(),
			);
			const { error: writeError } = await db.from("vendors").update(decision.patch).eq("id", v.id).eq("domain", v.domain);
			if (writeError) throw new Error(writeError.message);
			out.checked++;
			if (decision.cleared) out.cleared.push(v.slug);
		} catch (e) {
			out.errors.push({ slug: v.slug, detail: e instanceof Error ? e.message : String(e) });
		}
	}
	return out;
}
