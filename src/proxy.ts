import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * NOTE THE FILE NAME. Next 16 deprecated `middleware.ts` in favour of
 * `proxy.ts`, matching lettersprite. The export name follows the convention.
 *
 * Two unrelated concerns share this one entry point because Next only runs a
 * single proxy per project:
 *  1. Content negotiation for /proofs/{vendor} (unchanged, see below).
 *  2. The /staff login wall (own Supabase Auth, no SSO bridge — see the
 *     README's auth decision). Everything else — /v1/observe, /v1/config,
 *     /proofs/*, /attest/*, /.well-known/*, /api/cron/* — is the product's
 *     public collection/proof API and must stay reachable with no session, so
 *     unlike a typical login wall this does NOT default to gating everything.
 *     With no auth env configured, /staff 503s rather than falling open — an
 *     internal area has no safe "unauthenticated but allowed" default.
 */
export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	if (pathname.startsWith("/staff")) return staffAuthGate(request);

	const match = pathname.match(/^\/proofs\/([^/]+)$/);
	if (!match) return;

	const [, segment] = match;
	const suffixed = segment.endsWith(".json");
	const slug = suffixed ? segment.slice(0, -".json".length) : segment;

	if (suffixed || prefersJson(request.headers.get("accept"))) {
		return NextResponse.rewrite(new URL(`/api/proofs/${slug}`, request.url));
	}
}

async function staffAuthGate(request: NextRequest) {
	const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

	if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
		return NextResponse.json(
			{ error: "Staff auth is not configured on this deployment" },
			{ status: 503 },
		);
	}

	let response = NextResponse.next({ request });

	const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
		cookies: {
			getAll() {
				return request.cookies.getAll();
			},
			setAll(cookiesToSet) {
				cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
				response = NextResponse.next({ request });
				cookiesToSet.forEach(({ name, value, options }) =>
					response.cookies.set(name, value, options),
				);
			},
		},
	});

	const {
		data: { user },
	} = await supabase.auth.getUser();

	if (request.nextUrl.pathname.startsWith("/staff/login")) return response;

	if (!user) {
		const loginUrl = request.nextUrl.clone();
		loginUrl.pathname = "/staff/login";
		loginUrl.search = "";
		loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
		return NextResponse.redirect(loginUrl);
	}

	return response;
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

export const config = { matcher: ["/proofs/:path*", "/staff/:path*"] };
