/**
 * The minimum of Maverick Intelligence's API that visitor identification
 * needs: list identified people, and register / deactivate a Tracked Domain.
 *
 * Ported from Letterstory's src/lib/maverick/client.ts (facts verified there
 * against docs.maverickintelligence.co, 2026-10-09/10), which runs the same
 * partner account:
 *
 *  - Base https://api-v1.maverickintelligence.co, auth `X-API-Key`. Two key
 *    kinds on one header: the `mk_live_…` Developer key serves data reads
 *    (/v1/people) and the `pk_live_…` PARTNER key serves /v1/partner/*. Each
 *    403s on the other's endpoints, which surfaces as "forbidden", never as an
 *    empty account.
 *  - Our account is a PARTNER account: every site is a Tracked Domain, and
 *    each person record carries the `domain` and `clientRef` it was seen on.
 *    POST /v1/partner/domains is idempotent (`existing: true` on a re-create)
 *    and answers with the account-level customerId the pixel ships; DELETE
 *    takes the domain in the BODY and soft-deactivates.
 *  - 1,000 requests/hour for the whole account, shared with Letterstory. 429
 *    carries Retry-After.
 *
 * Env: MAVERICK_API_KEY (data) and MAVERICK_PARTNER_API_KEY (partner), with
 * the LETTERBRACE_-prefixed names Letterstory uses accepted too, so one
 * Vercel integration can feed both projects.
 */

const BASE_URL = "https://api-v1.maverickintelligence.co";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = [1_000, 4_000];

function dataKey(): string | undefined {
	return process.env.MAVERICK_API_KEY || process.env.LETTERBRACE_MAVERICK_API_KEY || undefined;
}

function partnerKey(): string | undefined {
	return process.env.MAVERICK_PARTNER_API_KEY || process.env.LETTERBRACE_MAVERICK_PARTNER_API_KEY || undefined;
}

export function isMaverickConfigured(): boolean {
	return Boolean(dataKey());
}

export function isMaverickPartnerConfigured(): boolean {
	return Boolean(partnerKey());
}

/** An identified visitor as /v1/people returns it (the fields this app reads). */
export interface MaverickPerson {
	id: string;
	email: string | null;
	businessEmail: string | null;
	firstName: string | null;
	lastName: string | null;
	title: string | null;
	company: string | null;
	location: string | null;
	linkedinUrl: string | null;
	visitCount: number;
	firstSeen: string;
	lastSeen: string;
	classifiedSeniority: string | null;
	classifiedJobFunction: string | null;
	companyData: { name?: string; domain?: string; standardizedIndustry?: string; employeeCount?: number } | null;
	/** The Tracked Domain the person was seen on (partner accounts). */
	domain?: string | null;
	clientRef?: string | null;
}

export type MaverickResult<T> =
	| { ok: true; data: T }
	| { ok: false; reason: "unconfigured" | "forbidden" | "failed"; message: string };

type Fetcher = typeof fetch;

async function request<T>(
	path: string,
	init: { method?: "GET" | "POST" | "DELETE"; body?: Record<string, unknown>; key: "data" | "partner" },
	fetcher: Fetcher = fetch,
): Promise<MaverickResult<T>> {
	const apiKey = init.key === "partner" ? partnerKey() : dataKey();
	if (!apiKey) {
		return {
			ok: false,
			reason: "unconfigured",
			message: init.key === "partner" ? "MAVERICK_PARTNER_API_KEY is not set" : "MAVERICK_API_KEY is not set",
		};
	}

	let lastError = "";
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		let res: Response;
		try {
			res = await fetcher(`${BASE_URL}${path}`, {
				method: init.method ?? "GET",
				headers: { "X-API-Key": apiKey, ...(init.body ? { "Content-Type": "application/json" } : {}) },
				body: init.body ? JSON.stringify(init.body) : undefined,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			if (attempt < MAX_ATTEMPTS - 1) {
				await new Promise((r) => setTimeout(r, RETRY_AFTER_MS[attempt]));
				continue;
			}
			return { ok: false, reason: "failed", message: `Visitor identification request failed: ${lastError}` };
		}

		if (res.ok) return { ok: true, data: (await res.json()) as T };

		const detail = await res.text().catch(() => "");
		lastError = `${res.status}: ${detail.slice(0, 200) || res.statusText}`;
		if (res.status === 401 || res.status === 403) {
			return { ok: false, reason: "forbidden", message: `The visitor identification provider rejected the ${init.key} API key` };
		}
		if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
			await new Promise((r) => setTimeout(r, RETRY_AFTER_MS[attempt]));
			continue;
		}
		return { ok: false, reason: "failed", message: `Visitor identification request failed (${lastError})` };
	}
	return { ok: false, reason: "failed", message: `Visitor identification request failed after ${MAX_ATTEMPTS} attempts (${lastError})` };
}

/** GET /v1/people — identified visitors, newest activity first. */
export async function listPeople(
	opts: { limit?: number; cursor?: string; since?: string; clientRef?: string },
	fetcher?: Fetcher,
): Promise<MaverickResult<{ data: MaverickPerson[]; pagination: { nextCursor: string | null } }>> {
	const qs = new URLSearchParams();
	if (opts.limit) qs.set("limit", String(opts.limit));
	if (opts.cursor) qs.set("cursor", opts.cursor);
	if (opts.since) qs.set("since", opts.since);
	if (opts.clientRef) qs.set("client_ref", opts.clientRef);
	const s = qs.toString();
	return request(`/v1/people${s ? `?${s}` : ""}`, { key: "data" }, fetcher);
}

/**
 * POST /v1/partner/domains — register (or re-assert) a Tracked Domain.
 * `customerId` is the ACCOUNT's id, the same for every domain; `pixelSnippet`
 * is Maverick's own install tag, which carries the profile id too.
 */
export async function partnerCreateDomain(
	opts: { domain: string; clientRef?: string },
	fetcher?: Fetcher,
): Promise<MaverickResult<{ domain: string; existing: boolean; customerId: string; clientRef: string | null; pixelSnippet?: string }>> {
	return request(
		`/v1/partner/domains`,
		{ method: "POST", key: "partner", body: { domain: opts.domain, ...(opts.clientRef ? { clientRef: opts.clientRef } : {}) } },
		fetcher,
	);
}

/** DELETE /v1/partner/domains — deactivate a Tracked Domain (domain in the body). */
export async function partnerDeleteDomain(domain: string, fetcher?: Fetcher): Promise<MaverickResult<{ success: boolean }>> {
	return request(`/v1/partner/domains`, { method: "DELETE", key: "partner", body: { domain } }, fetcher);
}

/**
 * The pixel's profile id, read out of Maverick's own install snippet. It shows
 * up as `data-profile-id="…"` in the tag form or `profileId:"…"` in the loader
 * form; either is accepted. Null when the snippet carries neither.
 */
export function profileIdFromSnippet(snippet: string | null | undefined): string | null {
	if (!snippet) return null;
	const m = /data-profile-id=["']([A-Za-z0-9_-]+)["']/.exec(snippet) ?? /profileId["']?\s*:\s*["']([A-Za-z0-9_-]+)["']/.exec(snippet);
	return m ? m[1] : null;
}
