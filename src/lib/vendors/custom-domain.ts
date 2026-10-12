import { dbClient } from "@/lib/db/client";
import { normalizeDomain } from "@/lib/vendors/domain";

/**
 * A vendor's proof page on its own domain — proof.acme.com, success.acme.com.
 *
 * The vendor adds one CNAME. Letterprove attaches the hostname to its own
 * Vercel project (so Vercel issues the certificate and routes the traffic
 * here), and src/proxy.ts maps `/` on that host to `/proofs/{slug}`. Nothing
 * about the proof changes: the same page, the same signed documents, and every
 * verify link still pointing at app.letterprove.com — which is what keeps a
 * proof served from the vendor's own domain checkable rather than
 * self-published.
 *
 * WHY IT MUST SIT UNDER THE VENDOR'S OWN DOMAIN. The binding hostname → vendor
 * lives in our database, and is made before the CNAME exists. Without this
 * rule a vendor could claim proof.lettertrace.com today, and the day Lettertrace
 * points that name at us for its own proofs, visitors would get the first
 * vendor's page. Requiring the same registrable domain as the vendor's
 * DNS-verified `domain` means the claim is backed by DNS control we already
 * checked.
 */

/** Second-level suffixes under which the registrable domain is three labels, not two. */
const MULTI_PART_SUFFIXES = new Set([
	"co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
	"com.au", "net.au", "org.au", "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp",
	"co.in", "net.in", "org.in", "com.br", "com.mx", "com.ar", "com.sg", "com.hk",
	"co.za", "co.kr", "com.tr", "com.cn", "com.tw", "co.il", "com.my", "co.id",
]);

/** The registrable domain (eTLD+1) of a hostname, from a short suffix list. */
export function registrableDomain(host: string): string {
	const labels = host.split(".");
	if (labels.length <= 2) return host;
	const lastTwo = labels.slice(-2).join(".");
	return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export type CustomDomainCheck = { ok: true; domain: string } | { ok: false; error: string; detail: string };

/** Hosts that are already ours, or Vercel's, and can never be a vendor's proof domain. */
const RESERVED_ROOTS = ["letterprove.com", "vercel.app", "vercel-dns.com"];

/**
 * Whether `input` can be this vendor's proof hostname. It must be a real
 * subdomain (a CNAME cannot sit on an apex) of the vendor's registrable domain.
 */
export function checkCustomDomain(input: string, vendorDomain: string): CustomDomainCheck {
	const domain = normalizeDomain(input);
	if (!domain || domain === "localhost" || domain.includes(":")) {
		return { ok: false, error: "invalid_domain", detail: `"${input}" isn't a hostname. Use something like proof.yourcompany.com.` };
	}
	if (RESERVED_ROOTS.some((root) => domain === root || domain.endsWith(`.${root}`))) {
		return { ok: false, error: "invalid_domain", detail: `${domain} can't be used as a proof domain.` };
	}
	const base = registrableDomain(normalizeDomain(vendorDomain) ?? vendorDomain);
	if (registrableDomain(domain) !== base) {
		return {
			ok: false,
			error: "domain_not_yours",
			detail: `The proof domain has to be on ${base}, the domain you verified. Try proof.${base}.`,
		};
	}
	if (domain === base) {
		return {
			ok: false,
			error: "apex_not_supported",
			detail: `Use a subdomain such as proof.${base}. A CNAME can't be set on ${base} itself.`,
		};
	}
	return { ok: true, domain };
}

// ---------------------------------------------------------------- Vercel

/**
 * The Vercel project serving this app, and a token that can manage its domains.
 * Explicit env vars first; Vercel's own system variables as the fallback for
 * the project id.
 */
function vercelConfig(): { token: string; projectId: string; teamId: string | null } | null {
	const token = process.env.LETTERPROVE_VERCEL_TOKEN;
	const projectId = process.env.LETTERPROVE_VERCEL_PROJECT_ID ?? process.env.VERCEL_PROJECT_ID;
	if (!token || !projectId) return null;
	return { token, projectId, teamId: process.env.LETTERPROVE_VERCEL_TEAM_ID ?? null };
}

export function customDomainsConfigured(): boolean {
	return vercelConfig() !== null;
}

/** The CNAME target when Vercel recommends none. */
export const DEFAULT_CNAME_TARGET = "cname.vercel-dns.com";

export type VercelDomainState = {
	/** Vercel accepts the hostname as ours (no ownership challenge outstanding). */
	verified: boolean;
	/** DNS does not point at Vercel yet. */
	misconfigured: boolean;
	/** What the CNAME should point at. */
	cnameTarget: string;
	/** Extra TXT records Vercel wants, when the hostname is claimed by another Vercel account. */
	verification: { type: string; domain: string; value: string }[];
};

type Fetcher = typeof fetch;

async function vercel(path: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<Response> {
	const cfg = vercelConfig();
	if (!cfg) throw new Error("custom domains are not configured");
	const url = new URL(`https://api.vercel.com${path.replace("{project}", cfg.projectId)}`);
	if (cfg.teamId) url.searchParams.set("teamId", cfg.teamId);
	return fetcher(url, {
		...init,
		headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
		signal: AbortSignal.timeout(10_000),
	});
}

/** Attach a hostname to this project. Already attached counts as success. */
export async function attachDomain(domain: string, fetcher: Fetcher = fetch): Promise<{ ok: true } | { ok: false; detail: string }> {
	const res = await vercel(`/v10/projects/{project}/domains`, { method: "POST", body: JSON.stringify({ name: domain }) }, fetcher);
	if (res.ok) return { ok: true };
	const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
	if (body?.error?.code === "domain_already_in_use" || body?.error?.code === "domain_already_exists") {
		// Ours already (a retry), or another Vercel account's. getDomainState tells which.
		return { ok: true };
	}
	return { ok: false, detail: body?.error?.message ?? `Vercel refused ${domain} (${res.status}).` };
}

export async function detachDomain(domain: string, fetcher: Fetcher = fetch): Promise<void> {
	const res = await vercel(`/v9/projects/{project}/domains/${encodeURIComponent(domain)}`, { method: "DELETE" }, fetcher);
	// Already gone is fine; anything else is worth knowing but must not strand
	// the vendor with a domain they cannot remove from our side.
	if (!res.ok && res.status !== 404) console.error(`[letterprove:custom-domain] detach ${domain} failed: ${res.status}`);
}

export async function getDomainState(domain: string, fetcher: Fetcher = fetch): Promise<VercelDomainState | null> {
	const [projRes, cfgRes] = await Promise.all([
		vercel(`/v9/projects/{project}/domains/${encodeURIComponent(domain)}`, {}, fetcher),
		vercel(`/v6/domains/${encodeURIComponent(domain)}/config`, {}, fetcher),
	]);
	if (!projRes.ok) return null;
	const proj = (await projRes.json()) as { verified?: boolean; verification?: { type: string; domain: string; value: string }[] };
	const cfg = cfgRes.ok
		? ((await cfgRes.json()) as { misconfigured?: boolean; recommendedCNAME?: { rank: number; value: string }[] })
		: { misconfigured: true };
	const recommended = [...(cfg.recommendedCNAME ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value;
	return {
		verified: Boolean(proj.verified),
		misconfigured: cfg.misconfigured !== false,
		cnameTarget: (recommended ?? DEFAULT_CNAME_TARGET).replace(/\.$/, ""),
		verification: proj.verification ?? [],
	};
}

// ---------------------------------------------------------------- lookups

/**
 * The published vendor a hostname serves, for src/proxy.ts. Cached for a minute
 * per instance: the proxy runs on every request to a custom host, and a binding
 * changes about once per vendor lifetime.
 */
const hostCache = new Map<string, { slug: string | null; at: number }>();
const HOST_TTL_MS = 60_000;

export async function slugForCustomDomain(host: string): Promise<string | null> {
	const key = host.toLowerCase();
	const hit = hostCache.get(key);
	if (hit && Date.now() - hit.at < HOST_TTL_MS) return hit.slug;

	const db = dbClient();
	if (!db) return null;
	// Published only: an unpublished vendor's custom domain must 404 exactly as
	// its /proofs page does, or the hostname confirms who has installed us.
	const { data } = await db
		.from("vendors")
		.select("slug, proofs_published_at")
		.eq("custom_domain", key)
		.maybeSingle<{ slug: string; proofs_published_at: string | null }>();
	const slug = data?.proofs_published_at ? data.slug : null;
	hostCache.set(key, { slug, at: Date.now() });
	return slug;
}

/** A vendor's live custom domain (verified and configured), for the proof page's canonical URL. */
export async function liveCustomDomain(slug: string): Promise<string | null> {
	const db = dbClient();
	if (!db) return null;
	const { data } = await db
		.from("vendors")
		.select("custom_domain, custom_domain_verified_at")
		.eq("slug", slug)
		.maybeSingle<{ custom_domain: string | null; custom_domain_verified_at: string | null }>();
	return data?.custom_domain && data.custom_domain_verified_at ? data.custom_domain : null;
}

/** Hosts this app answers on as itself; anything else is a vendor's custom domain. */
export function isOwnHost(host: string): boolean {
	const h = host.toLowerCase().split(":")[0];
	return (
		h === "localhost" ||
		h === "127.0.0.1" ||
		h === "letterprove.com" ||
		h.endsWith(".letterprove.com") ||
		h.endsWith(".vercel.app")
	);
}

// ---------------------------------------------------------------- status

export type CustomDomainRow = {
	custom_domain: string | null;
	custom_domain_verified_at: string | null;
	proofs_published_at: string | null;
};

/**
 * The one answer every custom-domain tool gives. `state` is Vercel's live view,
 * or null when it was not asked (get) or could not be read.
 */
export function customDomainStatus(row: CustomDomainRow, state: VercelDomainState | null) {
	const domain = row.custom_domain;
	const published = Boolean(row.proofs_published_at);
	if (!domain) {
		return {
			domain: null, url: null, dns: null, extra_records: [], configured: false, verified: false,
			published, live: false, verified_at: null,
			message: "No proof domain set. Add one like proof.yourcompany.com to serve your proof page on your own domain.",
		};
	}
	// Without a live read, the last recorded check is the best answer we have.
	const verified = state ? state.verified : Boolean(row.custom_domain_verified_at);
	const configured = state ? !state.misconfigured : Boolean(row.custom_domain_verified_at);
	const live = configured && verified && published;
	const message = !configured
		? `Add a CNAME record for ${domain} pointing to ${state?.cnameTarget ?? DEFAULT_CNAME_TARGET} at your DNS provider, then check again. DNS can take a few minutes.`
		: !verified
			? `${domain} points at us, but Vercel wants the extra record below before it will serve it.`
			: !published
				? `${domain} is set up. It will show your proof page as soon as your proofs are published.`
				: `Your proof page is live at https://${domain}.`;
	return {
		domain,
		url: `https://${domain}`,
		dns: { type: "CNAME" as const, name: domain, value: state?.cnameTarget ?? DEFAULT_CNAME_TARGET },
		extra_records: state?.verification ?? [],
		configured,
		verified,
		published,
		live,
		verified_at: row.custom_domain_verified_at,
		message,
	};
}
