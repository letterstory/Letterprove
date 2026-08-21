import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { generateKey } from "@/lib/vendors/keys";
import { domainRejectionReason, normalizeDomain } from "@/lib/vendors/domain";

// Creates a brand-new vendor org + the signed-in user's membership row in
// it. RLS (see 20260814231500_vendor_self_signup_policies.sql) allows any
// authenticated user to insert exactly this pair through the session-bound
// client — no service-role client, no manual ownership check needed (see
// feedback_rls_trust_pattern).
export async function POST(request: NextRequest) {
	const supabase = await createServerSupabaseClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) {
		return NextResponse.json({ error: "Not signed in" }, { status: 401 });
	}

	const body = await request.json().catch(() => null);
	const name = typeof body?.name === "string" ? body.name.trim() : "";
	const domain = typeof body?.domain === "string" ? body.domain.trim() : "";
	const category = typeof body?.category === "string" ? body.category.trim() : "";

	if (!name || !domain || !category) {
		return NextResponse.json(
			{ error: "name, domain, and category are all required" },
			{ status: 400 },
		);
	}

	// The collector compares an incoming Origin header to this value for
	// equality, so anything but a bare hostname collects nothing — silently,
	// because /v1/observe is sendBeacon-safe and answers 204 either way.
	// Reject here, the one moment the vendor is looking at the field.
	const normalizedDomain = normalizeDomain(domain);
	if (!normalizedDomain) {
		return NextResponse.json({ error: domainRejectionReason(domain) }, { status: 400 });
	}

	const baseSlug = slugify(name);
	if (!baseSlug) {
		return NextResponse.json({ error: "Vendor name must contain letters or numbers" }, { status: 400 });
	}

	const key = generateKey(baseSlug);

	let vendorId = await insertVendor(supabase, baseSlug, name, normalizedDomain, category, key);

	if (vendorId === "conflict") {
		// Unique-slug conflict — retry once with a short random suffix.
		const retrySlug = `${baseSlug}-${randomBytes(2).toString("hex")}`;
		vendorId = await insertVendor(supabase, retrySlug, name, normalizedDomain, category, key);
	}

	if (vendorId === "conflict" || vendorId === null) {
		return NextResponse.json(
			{ error: "A vendor with that name already exists. Try a different name." },
			{ status: 409 },
		);
	}

	const { error: memberError } = await supabase
		.from("vendor_members")
		.insert({ vendor_id: vendorId, user_id: user.id });

	if (memberError) {
		return NextResponse.json({ error: "Failed to finish setting up your account" }, { status: 500 });
	}

	return NextResponse.redirect(new URL("/vendor", request.url), { status: 303 });
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

type SupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

/** Returns the new vendor's id, "conflict" on a unique-slug violation, or null on any other error. */
async function insertVendor(
	supabase: SupabaseClient,
	slug: string,
	name: string,
	domain: string,
	category: string,
	key: string,
): Promise<string | "conflict" | null> {
	// id is generated here, not left to the column default, so we don't need
	// `.select()` back afterward — the RLS select policy on vendors only
	// grants access via an existing vendor_members row, which doesn't exist
	// yet for a brand-new vendor. `.insert().select()` would 42501 on the
	// implicit RETURNING even though the insert itself is allowed.
	const id = randomUUID();
	const { error } = await supabase.from("vendors").insert({ id, slug, name, domain, category, key });

	if (error) {
		// Postgres unique_violation
		if (error.code === "23505") return "conflict";
		return null;
	}

	return id;
}
