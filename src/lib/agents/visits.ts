/**
 * AI agents and crawlers visiting a vendor's own site.
 *
 * A different question from the rest of Letterprove. Everything else asks
 * "who uses this vendor's product" and signs the answer; this asks "which
 * machines read this vendor's site" and keeps the answer private to the vendor.
 * Nothing here is read by the attestation, the tiers, or any public route.
 *
 * TWO WAYS IN, because most agents never run JavaScript.
 *
 *   server  The vendor's server (a middleware, an edge function) forwards each
 *           request's user-agent, client address and path to
 *           POST /api/v1/agent-visit. This is the only way to see ChatGPT,
 *           Claude, Perplexity and the search crawlers: they fetch HTML and
 *           leave, so a script tag never fires for them.
 *   client  attest.js, on a page an automated browser renders (ChatGPT's agent,
 *           Comet, anything with navigator.webdriver set). The request's own
 *           headers carry the user-agent and address; the page's Origin is the
 *           host.
 *
 * WHAT "VERIFIED" MEANS. The request came from an address the claimed
 * operator publishes for its agents (src/lib/access/verify-agent.ts). A
 * user-agent alone is self-reported. In server mode the address is the one the
 * vendor's server reported, so `verified` is only as honest as that server —
 * acceptable for analytics the vendor reads about itself, and the reason none
 * of it is ever evidence.
 *
 * NO ADDRESS AND NO RAW USER-AGENT ARE STORED. The classification is kept; the
 * strings that produced it are dropped, as in src/lib/access/log.ts.
 */

import { classify } from "@/lib/access/classify";
import { isVerifiedAgent } from "@/lib/access/verify-agent";
import { dbClient } from "@/lib/db/client";
import { readAllRows } from "@/lib/db/read-all";

export type AgentVisitKind = "ai_agent" | "search_crawler" | "automated_browser";

export interface AgentVisit {
	/** Canonical operator name from classify(), or "automated_browser". */
	agent: string;
	kind: AgentVisitKind;
}

/** Longest path stored. Longer ones are cut, not refused. */
export const MAX_PATH_LENGTH = 200;

/**
 * Which machine this was, or null for anything that isn't one (browsers,
 * unidentifiable clients) — those are not counted at all.
 *
 *   - A user-agent naming a known agent or crawler wins.
 *   - `Signature-Agent: "https://chatgpt.com"` is how ChatGPT's agent marks
 *     the requests its browser makes under an ordinary Chrome user-agent.
 *   - navigator.webdriver (reported by attest.js) is any automated browser:
 *     an agent, but also a test runner, so it gets its own kind.
 */
export function classifyVisit(input: {
	userAgent: string | null;
	signatureAgent?: string | null;
	webdriver?: boolean;
}): AgentVisit | null {
	const { kind, name } = classify(input.userAgent);
	if ((kind === "ai_agent" || kind === "search_crawler") && name) return { agent: name, kind };
	if (input.signatureAgent && input.signatureAgent.toLowerCase().includes("chatgpt.com")) {
		return { agent: "chatgpt", kind: "ai_agent" };
	}
	if (input.webdriver === true) return { agent: "automated_browser", kind: "automated_browser" };
	return null;
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,})$/i;

/**
 * A path fit to store: no query or fragment (they carry search terms and
 * tokens), id-like segments collapsed to `:id` so one article per row doesn't
 * become one row per visitor, and capped in length. Accepts a full URL too.
 * Null when there is nothing path-like at all.
 */
export function normalizePath(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	let path = raw.trim();
	if (!path) return null;
	if (/^https?:\/\//i.test(path)) {
		try {
			path = new URL(path).pathname;
		} catch {
			return null;
		}
	}
	path = path.split(/[?#]/)[0];
	if (!path.startsWith("/")) path = `/${path}`;
	path = path
		.split("/")
		.map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
		.join("/");
	return path.slice(0, MAX_PATH_LENGTH);
}

/**
 * Fold one visit into its day's row. Verified against the claimed operator's
 * published ranges first; agents and crawlers with no published list (and
 * automated browsers) are stored as claimed.
 */
export async function recordAgentVisit(
	vendorId: string,
	visit: AgentVisit,
	path: string,
	ip: string | null,
	at: Date = new Date(),
): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;
	const verified = visit.kind === "automated_browser" ? false : await isVerifiedAgent(visit.agent, ip);
	const { error } = await db.rpc("record_agent_visit", {
		p_vendor_id: vendorId,
		p_agent: visit.agent,
		p_kind: visit.kind,
		p_verified: verified,
		p_path: path,
		p_at: at.toISOString(),
	});
	if (error) {
		console.error("[letterprove:agent-visits] record failed", error.message);
		return false;
	}
	return true;
}

export interface AgentVisitsReport {
	days: number;
	since: string;
	total: number;
	verified: number;
	agents: { agent: string; kind: AgentVisitKind; total: number; verified: number; claimed: number; last_at: string }[];
	top_paths: { path: string; total: number }[];
	daily: { day: string; total: number; verified: number }[];
}

const TOP_PATHS = 20;

/**
 * The vendor's agent visits over the last `days` days (today included), for
 * the vendor's own eyes. Throws on a failed read — a dashboard showing zero
 * agents because a query broke is the kind of quiet wrong this repo avoids.
 */
export async function agentVisitsReport(vendorId: string, days: number, now: Date = new Date()): Promise<AgentVisitsReport> {
	const db = dbClient();
	if (!db) throw new Error("no datastore configured");

	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
	const since = start.toISOString().slice(0, 10);

	const rows = await readAllRows<{
		day: string;
		agent: string;
		kind: AgentVisitKind;
		verified: boolean;
		path: string;
		count: number;
		last_at: string;
	}>(`agent visits for ${vendorId}`, (from, to) =>
		db
			.from("vendor_agent_visits")
			.select("day, agent, kind, verified, path, count, last_at")
			.eq("vendor_id", vendorId)
			.gte("day", since)
			.order("day", { ascending: true })
			.order("agent", { ascending: true })
			.order("path", { ascending: true })
			.range(from, to),
	);

	const agents = new Map<string, AgentVisitsReport["agents"][number]>();
	const paths = new Map<string, number>();
	const daily = new Map<string, { total: number; verified: number }>();
	let total = 0;
	let verified = 0;

	for (const row of rows) {
		const count = Number(row.count);
		const day = String(row.day).slice(0, 10);
		const lastAt = new Date(row.last_at).toISOString();
		total += count;
		if (row.verified) verified += count;

		const key = `${row.kind}:${row.agent}`;
		const agent = agents.get(key) ?? { agent: row.agent, kind: row.kind, total: 0, verified: 0, claimed: 0, last_at: lastAt };
		agent.total += count;
		if (row.verified) agent.verified += count;
		else agent.claimed += count;
		if (lastAt > agent.last_at) agent.last_at = lastAt;
		agents.set(key, agent);

		paths.set(row.path, (paths.get(row.path) ?? 0) + count);

		const d = daily.get(day) ?? { total: 0, verified: 0 };
		d.total += count;
		if (row.verified) d.verified += count;
		daily.set(day, d);
	}

	return {
		days,
		since,
		total,
		verified,
		agents: [...agents.values()].sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent)),
		top_paths: [...paths.entries()]
			.map(([path, n]) => ({ path, total: n }))
			.sort((a, b) => b.total - a.total || a.path.localeCompare(b.path))
			.slice(0, TOP_PATHS),
		daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d })),
	};
}
