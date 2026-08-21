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
		// Whichever vendor was last switched to, falling back to the oldest
		// membership when nothing has been. Two terms, both needed: without an
		// order at all, `limit(1)` is whichever row Postgres happens to return
		// and can differ between requests — the dashboard would change under a
		// user, key and install snippet included. Without the fallback, a user
		// who has never opened the switcher has no vendor at all.
		.order("last_selected_at", { ascending: false, nullsFirst: false })
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
export interface VendorMembership {
	id: string;
	name: string;
	slug: string;
	domain: string;
}

export const vendorMemberships = cache(async (): Promise<VendorMembership[]> => {
	const user = await getUser();
	if (!user) return [];

	const supabase = await createServerSupabaseClient();
	const { data } = await supabase
		.from("vendor_members")
		.select("vendors(id, name, slug, domain)")
		// Same order the switcher shows them in, and the same order
		// currentVendor() resolves — so the first entry in this list is always
		// the one the dashboard is actually showing.
		.order("last_selected_at", { ascending: false, nullsFirst: false })
		.order("created_at", { ascending: true })
		.returns<{ vendors: VendorMembership | null }[]>();

	return (data ?? []).flatMap((row) => (row.vendors ? [row.vendors] : []));
});
