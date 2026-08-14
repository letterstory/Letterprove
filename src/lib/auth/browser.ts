import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client for staff authentication only (sign in / sign
// up / sign out). Uses the public anon key — never the service-role key. Data
// access for the product itself still happens exclusively through server
// routes using src/lib/db/client.ts.
export function createClient() {
	return createBrowserClient(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
	);
}
