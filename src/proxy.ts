import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isStaffUser } from "@/lib/staff/allowlist";

/**
 * NOTE THE FILE NAME. Next 16 deprecated `middleware.ts` in favour of
 * `proxy.ts`, matching lettersprite. The export name follows the convention.
 *
 * Three unrelated concerns share this one entry point because Next only runs
 * a single proxy per project:
 *  1. Content negotiation for /proofs/{vendor} (unchanged, see below).
 *  2. The /staff login wall (own Supabase Auth, no SSO bridge — see the
 *     README's auth decision).
 *  3. The /vendor login wall — same Supabase Auth instance and session
 *     cookies as /staff (one user pool, not two), but a distinct gate: a
 *     vendor also needs a `vendor_members` row, since signing in alone only
 *     proves *a* user, not *which* vendor. A signed-in user with no
 *     membership yet is sent to /vendor/onboarding to create their org,
 *     which is itself inside the matcher but exempted from the membership
 *     check (see vendorAuthGate).
 * Everything else — /v1/observe, /v1/config, /proofs/*, /attest/*,
 * /.well-known/*, /api/cron/* — is the product's public collection/proof API
 * and must stay reachable with no session, so unlike a typical login wall
 * this does NOT default to gating everything. With no auth env configured,
 * both walls 503 rather than falling open — an internal/account area has no
 * safe "unauthenticated but allowed" default.
 */
export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	if (pathname.startsWith("/staff")) return staffAuthGate(request);
	if (pathname.startsWith("/vendor")) return vendorAuthGate(request);

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

	// Having a session is not being staff. Staff and vendors share one user
	// pool, and signup is open, so without this any registered account could
	// read every vendor's withheld customer domains. The vendor gate below has
	// always demanded a membership row for the same reason.
	//
	// Sent to the login page rather than redirected onward or looped: it is
	// exempted above, so it can state plainly that this account lacks access
	// without bouncing a signed-in user back and forth.
	if (!isStaffUser(user.id)) {
		const deniedUrl = request.nextUrl.clone();
		deniedUrl.pathname = "/staff/login";
		deniedUrl.search = "";
		deniedUrl.searchParams.set("denied", "1");
		return NextResponse.redirect(deniedUrl);
	}

	return response;
}

async function vendorAuthGate(request: NextRequest) {
	const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

	if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
		return NextResponse.json(
			{ error: "Vendor auth is not configured on this deployment" },
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

	if (request.nextUrl.pathname.startsWith("/vendor/login")) return response;

	if (!user) {
		const loginUrl = request.nextUrl.clone();
		loginUrl.pathname = "/vendor/login";
		loginUrl.search = "";
		loginUrl.searchParams.set("redirect", request.nextUrl.pathname);
		return NextResponse.redirect(loginUrl);
	}

	// Onboarding is reachable by any signed-in user regardless of membership —
	// it's the page that CREATES the first membership row, so gating it on
	// having one would make it unreachable.
	if (request.nextUrl.pathname.startsWith("/vendor/onboarding")) return response;

	// Signed in, but does this user belong to a vendor yet? A fresh signup has
	// a session and no vendor_members row — RLS scopes this select to
	// auth.uid() already (see the migration), so an empty result really does
	// mean "no membership", not "blocked from seeing someone else's".
	const { data: membership } = await supabase.from("vendor_members").select("vendor_id").limit(1).maybeSingle();
	if (!membership) {
		const onboardingUrl = request.nextUrl.clone();
		onboardingUrl.pathname = "/vendor/onboarding";
		onboardingUrl.search = "";
		return NextResponse.redirect(onboardingUrl);
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

export const config = { matcher: ["/proofs/:path*", "/staff/:path*", "/vendor/:path*"] };
