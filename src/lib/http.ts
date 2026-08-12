import { NextResponse } from "next/server";

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
			"cache-control": `public, max-age=${ttl}, stale-while-revalidate=86400`,
			"access-control-allow-origin": "*",
			// Diagnostics across a distributed install: one curl answers "is this
			// deploy serving proofs at all", without parsing the body.
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
 * `GET /v1/config` — cached via real `Cache-Control`/`stale-while-revalidate`
 * so the browser does the work, not a custom TTL field. Short-lived on
 * purpose: signals are meant to change without a script re-ship, and this is
 * how fast that change actually reaches an already-loaded vendor page.
 */
export function configJson(body: unknown, maxAge = 300): NextResponse {
	return NextResponse.json(body, {
		headers: {
			"cache-control": `public, max-age=${maxAge}, stale-while-revalidate=3600`,
			"access-control-allow-origin": "*",
			"x-letterprove": "on",
		},
	});
}
