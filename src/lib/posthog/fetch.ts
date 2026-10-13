/**
 * Read a vendor's PostHog project — the only file that talks to PostHog.
 *
 * Everything goes through one HogQL query endpoint
 * (`POST /api/projects/{id}/query/`), which a personal API key with the
 * `query:read` scope can call and nothing else. POST is PostHog's transport
 * for a read here; no request in this file creates, updates or captures
 * anything, and the key's scope means none could.
 *
 * What is read is deliberately coarse: the domain part of identified people's
 * email addresses, grouped. No address, name or person id leaves PostHog — the
 * split happens in the query, so the API never even returns them.
 */

import { normalizeDomain } from "@/lib/vendors/domain";

const TIMEOUT_MS = 30_000;
/** Rows per query. A project with more identified company domains than this is reported as truncated. */
export const ROW_LIMIT = 10_000;

export type QueryResult = { ok: true; rows: unknown[][] } | { ok: false; status: number; error: string; auth: boolean };

type Fetcher = typeof fetch;

export async function hogql(
	target: { key: string; apiHost: string; projectId: string },
	query: string,
	fetcher: Fetcher = fetch,
): Promise<QueryResult> {
	let res: Response;
	try {
		res = await fetcher(`${target.apiHost}/api/projects/${encodeURIComponent(target.projectId)}/query/`, {
			method: "POST",
			headers: { authorization: `Bearer ${target.key}`, "content-type": "application/json" },
			body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		return { ok: false, status: 0, auth: false, error: `PostHog did not answer: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (res.status === 401) {
		return { ok: false, status: 401, auth: true, error: "PostHog rejected the key. Create a personal API key with the query:read scope." };
	}
	if (res.status === 403) {
		return {
			ok: false,
			status: 403,
			auth: true,
			error: "The key can't read this project. Give it the query:read scope and access to this project (or all projects).",
		};
	}
	if (res.status === 404) {
		return { ok: false, status: 404, auth: true, error: "No PostHog project with that id is visible to this key." };
	}
	const body = (await res.json().catch(() => null)) as { results?: unknown; detail?: string } | null;
	if (!res.ok || !body || !Array.isArray(body.results)) {
		return { ok: false, status: res.status, auth: false, error: body?.detail ?? `PostHog query failed (${res.status}).` };
	}
	return { ok: true, rows: body.results as unknown[][] };
}

/** The company-domain expression, computed inside PostHog so addresses never leave it. */
const domainOf = (emailExpr: string) => `lower(trim(splitByChar('@', toString(${emailExpr}))[2]))`;

/** Every identified domain, with when PostHog first saw a person from it. */
export const HISTORY_QUERY = `
SELECT ${domainOf("properties.email")} AS domain, min(created_at) AS first_seen, count() AS people
FROM persons
WHERE toString(properties.email) LIKE '%_@_%'
GROUP BY domain
ORDER BY people DESC
LIMIT ${ROW_LIMIT}`;

/** Activity in the last 30 days, per identified domain. */
export const ACTIVITY_QUERY = `
SELECT ${domainOf("person.properties.email")} AS domain,
	count(DISTINCT person_id) AS people,
	count(DISTINCT properties.$session_id) AS sessions,
	max(timestamp) AS last_seen
FROM events
WHERE timestamp > now() - INTERVAL 30 DAY AND toString(person.properties.email) LIKE '%_@_%'
GROUP BY domain
LIMIT ${ROW_LIMIT}`;

/**
 * Events in the last 30 days on the vendor's own hosts. The binding check:
 * a project that never sees the vendor's domain is not this product's
 * analytics, whatever it contains. Hosts are normalized domains (letters,
 * digits, dots, hyphens) before they reach here, so they are safe to inline.
 */
export function hostEventsQuery(hosts: readonly string[]): string {
	const safe = hosts.filter((h) => /^[a-z0-9.-]+$/.test(h));
	if (safe.length === 0) return "SELECT 0";
	const conditions = safe.map((h) => `(host = '${h}' OR endsWith(host, '.${h}'))`).join(" OR ");
	return `
SELECT count() FROM (
	SELECT lower(splitByChar(':', toString(properties.$host))[1]) AS host
	FROM events
	WHERE timestamp > now() - INTERVAL 30 DAY
)
WHERE ${conditions}`;
}

export interface HistoryRow {
	domain: string;
	firstSeen: string | null;
	people: number;
}

export interface ActivityRow {
	domain: string;
	people: number;
	sessions: number;
	lastSeen: string | null;
}

function iso(v: unknown): string | null {
	if (typeof v !== "string" && typeof v !== "number") return null;
	const t = Date.parse(String(v));
	return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function int(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Parse history rows, keeping only rows whose domain normalizes. */
export function parseHistory(rows: unknown[][]): HistoryRow[] {
	const out: HistoryRow[] = [];
	for (const [domain, firstSeen, people] of rows) {
		const d = typeof domain === "string" ? normalizeDomain(domain) : null;
		if (!d) continue;
		out.push({ domain: d, firstSeen: iso(firstSeen), people: int(people) });
	}
	return out;
}

export function parseActivity(rows: unknown[][]): ActivityRow[] {
	const out: ActivityRow[] = [];
	for (const [domain, people, sessions, lastSeen] of rows) {
		const d = typeof domain === "string" ? normalizeDomain(domain) : null;
		if (!d) continue;
		out.push({ domain: d, people: int(people), sessions: int(sessions), lastSeen: iso(lastSeen) });
	}
	return out;
}
