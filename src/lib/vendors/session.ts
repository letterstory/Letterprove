import { cache } from "react";
import { createServerSupabaseClient, getUser } from "@/lib/auth/server";

export interface CurrentVendor {
	id: string;
	slug: string;
	name: string;
	domain: string;
	category: string;
	key: string;
}

interface VendorMembershipRow {
	vendors: {
		id: string;
		slug: string;
		name: string;
		domain: string;
		category: string;
		key: string;
	} | null;
}

/**
 * The vendor the signed-in user belongs to, or null if signed out or
 * membership-less (the latter shouldn't reach a page that calls this — the
 * proxy's vendorAuthGate already redirects those users to /vendor/onboarding
 * — but every caller should still treat null as "no vendor", not throw).
 *
 * Goes through the session-bound client, not `dbClient()`: `vendor_members`
 * and `vendors` both carry RLS scoped to `auth.uid()` (see the migration),
 * so this is a plain select, not a manual membership check — the DB is
 * already the source of truth for "does this user belong to this vendor"
 * (see feedback_rls_trust_pattern).
 *
 * cache()d per request: the layout needs this to decide whether to show the
 * section tabs, and the page it wraps needs the same row. Two identical
 * queries in one render is just latency.
 */
export const currentVendor = cache(async (): Promise<CurrentVendor | null> => {
	const user = await getUser();
	if (!user) return null;

	const supabase = await createServerSupabaseClient();
	const { data } = await supabase
		.from("vendor_members")
		.select("vendors(id, slug, name, domain, category, key)")
		// `limit(1)` without an order is whichever row Postgres happens to
		// return, and that can differ between requests — so a user in two
		// vendors could watch the dashboard switch under them, with the key
		// and install snippet switching too. Oldest membership wins: it is
		// stable, and it is the vendor they created first.
		.order("created_at", { ascending: true })
		.limit(1)
		.maybeSingle<VendorMembershipRow>();

	return data?.vendors ?? null;
});

/**
 * Every vendor the signed-in user belongs to, not just the first.
 *
 * currentVendor() above answers "which vendor is this dashboard for" and takes
 * limit 1 because the dashboard has one. The OAuth consent screen has to ask
 * instead of assume: a CLI token is minted for exactly one vendor, so if the
 * user belongs to several, picking silently would hand the terminal a
 * credential for a vendor they did not choose. Same RLS-scoped select, no
 * manual ownership check (see feedback_rls_trust_pattern).
 */
export const vendorMemberships = cache(async (): Promise<{ id: string; name: string }[]> => {
	const user = await getUser();
	if (!user) return [];

	const supabase = await createServerSupabaseClient();
	const { data } = await supabase
		.from("vendor_members")
		.select("vendors(id, name)")
		.returns<{ vendors: { id: string; name: string } | null }[]>();

	return (data ?? []).flatMap((row) => (row.vendors ? [row.vendors] : []));
});
