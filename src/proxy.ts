import { NextResponse, type NextRequest } from "next/server";

/**
 * NOTE THE FILE NAME. Next 16 deprecated `middleware.ts` in favour of
 * `proxy.ts`, matching lettersprite. The export name follows the convention.
 *
 * Now that Letterprove holds no identity of its own — its dashboard, login, and
 * OAuth server are retired and Letterstory is the sole identity authority — the
 * only concern left at this entry point is content negotiation for the public
 * proof surface:
 *
 *   /proofs/{vendor} serves a human page by default, but the same URL with a
 *   `.json` suffix or an explicit JSON `Accept` (and no HTML alternative) is
 *   rewritten to the machine endpoint at /api/proofs/{vendor}. Agents fetch
 *   exactly what they always did.
 *
 * Everything else — /v1/observe, /v1/config, /proofs/*, /attest/*,
 * /.well-known/*, /api/cron/* — is the product's public collection/proof API
 * and stays reachable with no session; this does not gate anything.
 */
export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	const match = pathname.match(/^\/proofs\/([^/]+)$/);
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

export const config = { matcher: ["/proofs/:path*"] };
