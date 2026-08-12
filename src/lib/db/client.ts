import { createClient } from "@supabase/supabase-js";

/**
 * Server-only, service-role client. Hot-tier writes bypass RLS by design —
 * `hot_events` has no policies (see the migration), so only this client can
 * touch it. Never import this from a client component or route that's
 * reachable with the publishable key.
 */
export function dbClient() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) return null;

	return createClient(url, key, {
		auth: { persistSession: false },
	});
}
