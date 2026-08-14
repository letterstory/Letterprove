import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Landing point for the link in a Supabase email-confirmation (and any future
// magic link / OAuth). Swaps `?code=` for a session cookie, then forwards to
// the originally-requested /staff page. Outside the /staff matcher, so it's
// reachable while signed out regardless of auth config.
export async function GET(request: NextRequest) {
	const { searchParams, origin } = request.nextUrl;
	const code = searchParams.get("code");

	const redirect = searchParams.get("redirect") || "/staff";
	const dest = redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/staff";

	if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !code) {
		return NextResponse.redirect(new URL("/staff/login", origin));
	}

	const response = NextResponse.redirect(new URL(dest, origin));

	const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
		cookies: {
			getAll() {
				return request.cookies.getAll();
			},
			setAll(cookiesToSet) {
				cookiesToSet.forEach(({ name, value, options }) =>
					response.cookies.set(name, value, options),
				);
			},
		},
	});

	const { error } = await supabase.auth.exchangeCodeForSession(code);
	if (error) {
		return NextResponse.redirect(new URL("/staff/login?error=auth", origin));
	}

	return response;
}
