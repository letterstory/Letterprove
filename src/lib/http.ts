import { NextResponse } from "next/server";
import { SNAPSHOT_CADENCE_SECONDS } from "@/lib/attest/cadence";

/**
 * Keep Vercel's edge from answering proof reads on the function's behalf.
 *
 * `cache-control` stays as it is for the agent, browser or proxy downstream:
 * they may keep a proof for its ttl. But an edge HIT never runs the route, so
 * it never reaches `logProofAccess` — the read is invisible to the access log
 * AND to agentic-read billing. Measured 2026-10-07: back-to-back fetches of
 * /attest/lettertrace.json came back MISS then HIT, and a day of Claude,
 * ChatGPT and Gemini fetches recorded zero agentic_read_events rows. Every
 * read after the first in each hour was going unseen.
 *
 * `Vercel-CDN-Cache-Control` governs only Vercel's own cache and is stripped
 * before the response leaves, so downstream caching is unchanged.
 */
const NO_EDGE_CACHE = { "vercel-cdn-cache-control": "no-store" } as const;

/**
 * Every proof response an agent reads.
 *
 * Cached for the attestation's own `ttl` and CORS-open, because a proof nobody
 * can fetch cross-origin is not proof. `stale-while-revalidate` is deliberate:
 * a slightly old signed snapshot is strictly better than a failed fetch, and
 * the document carries `observed_through` so staleness is self-describing.
 */
export function proofJson(body: unknown, ttl = 3600): NextResponse {
	return NextResponse.json(body, {
		headers: {
			// JSON is UTF-8 by definition (RFC 8259) so this is redundant to a
			// correct client — but a signature is over UTF-8 BYTES, and a consumer
			// that guesses latin-1 recomputes different bytes and fails to verify
			// a perfectly good document. Non-ASCII is unavoidable here: customer
			// names are company names. Being explicit costs nothing.
			"content-type": "application/json; charset=utf-8",
			"cache-control": `public, max-age=${ttl}, stale-while-revalidate=86400`,
			...NO_EDGE_CACHE,
			"access-control-allow-origin": "*",
			// Diagnostics across a distributed install: one curl answers "is this
			// deploy serving proofs at all", without parsing the body.
			"x-letterprove": "on",
		},
	});
}

/**
 * A proof response that NAMES a third party, cached far more briefly.
 *
 * Consent is withdrawable, and withdrawal is the one operation that has to
 * take effect now. `proofJson` caches for an hour with a DAY of
 * stale-while-revalidate — correct for an aggregate that names nobody, and
 * badly wrong here: a customer who withdraws could stay publicly named, and
 * their attestation publicly fetchable, long after the database says
 * otherwise. Measured in production: a revoked customer was still served from
 * cache after the revert.
 *
 * 60 seconds, and no stale-while-revalidate at all. SWR is the specific
 * hazard — it authorises serving a document the origin has already stopped
 * publishing. Losing edge caching on these is the correct trade: the aggregate
 * carries the numbers agents fetch in bulk, while a named per-customer
 * document is read rarely and must be right.
 */
export function namedProofJson(body: unknown): NextResponse {
	return NextResponse.json(body, {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=60, must-revalidate",
			...NO_EDGE_CACHE,
			"access-control-allow-origin": "*",
			"x-letterprove": "on",
		},
	});
}

/**
 * A plain-language proof page — what /verify/{vendor}/{stamp} serves to a
 * browser or an answer engine's fetch tool. Same cache policy as the JSON it
 * describes: an hour for an aggregate, a minute and no SWR for anything that
 * names a customer, and never answered from Vercel's edge (see NO_EDGE_CACHE).
 */
export function proofHtml(html: string, { names: namesCustomer }: { names: boolean }): NextResponse {
	return new NextResponse(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": namesCustomer
				? "public, max-age=60, must-revalidate"
				: `public, max-age=${SNAPSHOT_CADENCE_SECONDS}, stale-while-revalidate=86400`,
			...NO_EDGE_CACHE,
			"access-control-allow-origin": "*",
			"x-letterprove": "on",
		},
	});
}

export function notFound(what: string): NextResponse {
	return NextResponse.json(
		{ error: "not_found", detail: what },
		{ status: 404, headers: { "access-control-allow-origin": "*", "x-letterprove": "on" } }
	);
}

/**
 * The only response `POST /v1/observe` ever sends — per Reliability, always
 * `204`, even on a bad key or a malformed body. Status lives entirely in
 * `x-letterprove`, never the body: a host page must never see a failure, so
 * there is nothing here for it to parse.
 */
export function collectorResponse(accepted: boolean): NextResponse {
	return new NextResponse(null, {
		status: 204,
		headers: {
			"access-control-allow-origin": "*",
			"x-letterprove": accepted ? "on" : "off",
		},
	});
}

/**
 * A request over its rate limit. No `cache-control`: a client that backs off
 * and retries shortly must not have this response cached against it.
 */
export function rateLimited(): NextResponse {
	return NextResponse.json(
		{ error: "rate_limited" },
		{ status: 429, headers: { "access-control-allow-origin": "*", "x-letterprove": "on" } }
	);
}

/**
 * `GET /v1/config` — cached via real `Cache-Control`/`stale-while-revalidate`
 * so the browser does the work, not a custom TTL field. Short-lived on
 * purpose: signals are meant to change without a script re-ship, and this is
 * how fast that change actually reaches an already-loaded vendor page.
 */
export function configJson(body: unknown, maxAge = 300): NextResponse {
	return NextResponse.json(body, {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": `public, max-age=${maxAge}, stale-while-revalidate=3600`,
			"access-control-allow-origin": "*",
			"x-letterprove": "on",
		},
	});
}
