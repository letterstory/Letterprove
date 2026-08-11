import { NextResponse, type NextRequest } from "next/server";

/**
 * Content negotiation for /proofs/{vendor}.
 *
 * NOTE THE FILE NAME. Next 16 deprecated `middleware.ts` in favour of
 * `proxy.ts`, matching lettersprite. The export name follows the convention.
 *
 * One URL serves a human and an agent — the site's whole claim is that the
 * proof a buyer reads and the proof a machine parses are the same artifact, so
 * they should not live at different addresses. A browser gets the page; an
 * `Accept: application/json` request, or an explicit `.json` suffix for the
 * benefit of anything that cannot set headers, gets the document.
 */
export function proxy(request: NextRequest) {
	const match = request.nextUrl.pathname.match(/^\/proofs\/([^/]+)$/);
	if (!match) return;

	const [, segment] = match;
	const suffixed = segment.endsWith(".json");
	const slug = suffixed ? segment.slice(0, -".json".length) : segment;

	if (suffixed || prefersJson(request.headers.get("accept"))) {
		return NextResponse.rewrite(new URL(`/api/proofs/${slug}`, request.url));
	}
}

/**
 * Browsers send `text/html,...,*\/*`, so a bare wildcard must NOT count as
 * asking for JSON — that would serve raw documents to people. Only an explicit
 * JSON preference with no HTML alternative counts.
 */
function prefersJson(accept: string | null): boolean {
	if (!accept) return false;
	const lower = accept.toLowerCase();
	return lower.includes("application/json") && !lower.includes("text/html");
}

export const config = { matcher: "/proofs/:path*" };
