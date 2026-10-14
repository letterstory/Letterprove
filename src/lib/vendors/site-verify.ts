import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { after } from "next/server";
import { dbClient } from "@/lib/db/client";
import { fetchLogoPage } from "@/lib/vendors/logo-wall";

/**
 * Site proof: the vendor's own key, in one of our script tags on its homepage.
 *
 * Visitor identification (People, src/lib/vendors/visitors.ts) hands a vendor
 * the people seen on its site, so it must only ever go to whoever controls that
 * site. DNS proves control of the domain; this proves control of the site, and
 * asks nothing extra of the vendor: the Visitors script it has to install anyway
 * carries its key (`data-key`), and only someone who can edit the site can put
 * that key in its HTML. The config ping (`Origin: acme.com`) is NOT proof: any
 * server can send that header. So the check is ours: we fetch the page.
 *
 * The attestation does not accept this. Tiers rest on DNS, unchanged.
 *
 * WHAT COUNTS. A `<script>` tag whose `src` is lettervisit.com/v.js or
 * app.letterprove.com/attest.js and whose `data-key` is exactly the vendor's
 * current key, in the HTML of https://<domain>/ or, failing that,
 * https://www.<domain>/. Redirects are followed only within the same
 * registrable domain (fetchLogoPage). A tag injected by a tag manager isn't in
 * the HTML and doesn't count; DNS is the fallback for those sites.
 *
 * SSRF. The domain is vendor-supplied. IP literals and names that resolve to a
 * private, loopback or link-local address are refused before any fetch.
 *
 * KEPT CURRENT like DNS (src/lib/vendors/dns-recheck.ts): the daily re-check
 * re-fetches, and three misses over two days clear site_verified_at. A page we
 * couldn't load counts as a miss only when it answered; a timeout doesn't.
 */

export const SCRIPT_SRCS = ["lettervisit.com/v.js", "app.letterprove.com/attest.js"];
export const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const MISSES_TO_CLEAR = 3;
export const MIN_FAILING_MS = 48 * 60 * 60 * 1000;

type Fetcher = typeof fetch;
export type Lookup = (host: string) => Promise<string[]>;

const liveLookup: Lookup = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

export interface SiteCheck {
	verified: boolean;
	/** The page the key was found on, or the last page tried. */
	checked_url: string | null;
	reason: string;
	/** True when the page answered but the key wasn't on it (a real miss, for the re-check). */
	answered: boolean;
}

/** Pure: does this HTML carry `key` in one of our script tags? */
export function htmlHasKey(html: string, key: string): boolean {
	for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
		const attrs = m[1];
		const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
		const dataKey = /\bdata-key\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
		const normalizedSrc = src.replace(/^(https?:)?\/\//i, "").split(/[?#]/)[0].toLowerCase();
		if (dataKey === key && SCRIPT_SRCS.includes(normalizedSrc)) return true;
	}
	return false;
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

async function publicHost(host: string, lookup: Lookup): Promise<string | null> {
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

/** Look for the key on the site. Never throws, never writes. */
export async function checkSite(domain: string, key: string, deps: { fetcher?: Fetcher; lookup?: Lookup } = {}): Promise<SiteCheck> {
	const fetcher = deps.fetcher ?? fetch;
	const lookup = deps.lookup ?? liveLookup;
	if (isIP(domain)) return { verified: false, checked_url: null, reason: `${domain} isn't a public hostname.`, answered: false };
	const hosts = domain.startsWith("www.") ? [domain] : [domain, `www.${domain}`];
	let last: SiteCheck = { verified: false, checked_url: null, reason: "Nothing was checked.", answered: false };
	for (const host of hosts) {
		const url = `https://${host}/`;
		const refused = await publicHost(host, lookup);
		if (refused) {
			last = { verified: false, checked_url: url, reason: refused, answered: false };
			continue;
		}
		let page: Awaited<ReturnType<typeof fetchLogoPage>>;
		try {
			page = await fetchLogoPage(url, fetcher);
		} catch (e) {
			// A host the URL parser rejects, say. Never throws.
			last = { verified: false, checked_url: url, reason: `Couldn't load ${url}: ${e instanceof Error ? e.message : String(e)}`, answered: false };
			continue;
		}
		if (!page.ok) {
			// An HTTP answer (404, a redirect off the domain) is the site speaking;
			// a thrown fetch (timeout, DNS, TLS) is us failing to ask.
			last = { verified: false, checked_url: url, reason: page.detail, answered: !page.detail.startsWith("Couldn't load") };
			continue;
		}
		if (htmlHasKey(page.html, key)) {
			return { verified: true, checked_url: url, reason: `Found your script on ${url}.`, answered: true };
		}
		last = {
			verified: false,
			checked_url: url,
			reason: `Your Visitors script isn't on ${url}. Add it to the page's HTML (a tag manager can't be checked; use the DNS record instead).`,
			answered: true,
		};
	}
	return last;
}

interface SiteRow {
	domain: string;
	key: string;
	site_verified_at: string | null;
	site_check_failures: number | null;
	site_failing_since: string | null;
}

export interface VerifySiteResult {
	verified: boolean;
	checked_url: string | null;
	reason: string;
	verified_at?: string | null;
}

/** Check now and record it. Null when the vendor can't be read. */
export async function verifySite(vendorId: string, deps: { fetcher?: Fetcher; lookup?: Lookup } = {}): Promise<VerifySiteResult | null> {
	const db = dbClient();
	if (!db) return null;
	const { data: row } = await db
		.from("vendors")
		.select("domain, key, site_verified_at, site_check_failures, site_failing_since")
		.eq("id", vendorId)
		.maybeSingle<SiteRow>();
	if (!row) return null;
	const now = new Date().toISOString();
	const check = await checkSite(row.domain, row.key, deps);
	if (check.verified) {
		const verifiedAt = row.site_verified_at ?? now;
		await db
			.from("vendors")
			.update({ site_verified_at: verifiedAt, site_checked_at: now, site_check_failures: 0, site_failing_since: null })
			.eq("id", vendorId)
			.eq("domain", row.domain);
		return { verified: true, checked_url: check.checked_url, reason: check.reason, verified_at: verifiedAt };
	}
	// A manual or automatic check that fails never clears an existing proof;
	// only the daily re-check's three-misses rule does.
	await db.from("vendors").update({ site_checked_at: now }).eq("id", vendorId);
	return { verified: Boolean(row.site_verified_at), checked_url: check.checked_url, reason: check.reason, verified_at: row.site_verified_at };
}

/**
 * Called from /v1/config once the Visitors script has been seen: check the
 * site at most every ten minutes until it is verified. Fire-and-forget.
 */
export async function maybeAutoVerifySite(vendorId: string): Promise<void> {
	const db = dbClient();
	if (!db) return;
	const { data } = await db
		.from("vendors")
		.select("site_verified_at, site_checked_at, visitors_script_seen_at")
		.eq("id", vendorId)
		.maybeSingle<{ site_verified_at: string | null; site_checked_at: string | null; visitors_script_seen_at: string | null }>();
	if (!data || data.site_verified_at || !data.visitors_script_seen_at) return;
	if (data.site_checked_at && Date.now() - new Date(data.site_checked_at).getTime() < AUTO_CHECK_INTERVAL_MS) return;
	await verifySite(vendorId);
}

/** Run maybeAutoVerifySite after the current response is sent. Never throws. */
export function scheduleSiteAutoVerify(vendorId: string): void {
	try {
		after(() =>
			maybeAutoVerifySite(vendorId).catch((e) => console.error(`[letterprove:site-verify] ${e instanceof Error ? e.message : String(e)}`)),
		);
	} catch (e) {
		// Outside a request scope (a script, a test): skip; the next ping retries.
		console.error(`[letterprove:site-verify] not scheduled: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ---------------------------------------------------------------- daily re-check

export interface SiteRecheckState {
	site_verified_at: string | null;
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
		.select("id, slug, domain, key, site_verified_at, site_check_failures, site_failing_since")
		.not("site_verified_at", "is", null)
		.is("domain_verified_at", null);
	if (error) {
		out.errors.push({ slug: "*", detail: error.message });
		return out;
	}
	for (const v of (data ?? []) as (SiteRow & { id: string; slug: string })[]) {
		try {
			const check = await checkSite(v.domain, v.key, deps);
			const decision = decideSiteRecheck(
				{ site_verified_at: v.site_verified_at, site_check_failures: v.site_check_failures ?? 0, site_failing_since: v.site_failing_since },
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
