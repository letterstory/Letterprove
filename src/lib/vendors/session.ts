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
 */
export async function currentVendor(): Promise<CurrentVendor | null> {
	const user = await getUser();
	if (!user) return null;

	const supabase = await createServerSupabaseClient();
	const { data } = await supabase
		.from("vendor_members")
		.select("vendors(id, slug, name, domain, category, key)")
		.limit(1)
		.maybeSingle<VendorMembershipRow>();

	return data?.vendors ?? null;
}
