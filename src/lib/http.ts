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
