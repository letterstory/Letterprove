import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

// Auth uses the *anon* key + a user session (cookies) — distinct from
// src/lib/db/client.ts's service-role client, which the hot-tier collection
// routes use and which must never be exposed to a browser session.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Staff auth is opt-in: with no anon key configured, /staff runs unreachable
// rather than open (see middleware.ts) — there's no "everyone in" default for
// an internal area, unlike the public collection/proof surfaces.
export function isAuthConfigured(): boolean {
	return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export async function createServerSupabaseClient() {
	const cookieStore = await cookies();
	return createServerClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
		cookies: {
			getAll() {
				return cookieStore.getAll();
			},
			setAll(cookiesToSet) {
				try {
					cookiesToSet.forEach(({ name, value, options }) =>
						cookieStore.set(name, value, options),
					);
				} catch {
					// Thrown when called from a Server Component; the session is
					// refreshed in middleware instead, so this is safe to ignore.
				}
			},
		},
	});
}

/**
 * The signed-in user, or null when signed out or auth isn't configured.
 *
 * cache()d so it runs once per request rather than once per caller. Rendering
 * /vendor/customers made four auth round-trips: the layout asked, then
 * currentVendor() asked again inside the layout, then the page called
 * currentVendor() and it asked again. They cannot disagree — it is one cookie
 * — so the extras were pure latency, and each is a network hop to Supabase.
 */
export const getUser = cache(async () => {
	if (!isAuthConfigured()) return null;
	const supabase = await createServerSupabaseClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	return user;
});
