import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Point the dashboard at another of the signed-in user's vendors.
 *
 * Goes through the session-bound client, not the service-role one: RLS on
 * vendor_members scopes both the read and the write to auth.uid(), so a
 * request naming somebody else's membership updates zero rows rather than
 * needing a hand-written ownership check that could drift from the policy.
 */
export async function POST(request: NextRequest) {
	const supabase = await createServerSupabaseClient();

	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

	let vendorId: unknown;
	try {
		({ vendorId } = await request.json());
	} catch {
		return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
	}
	if (typeof vendorId !== "string" || !vendorId) {
		return NextResponse.json({ error: "vendorId is required." }, { status: 400 });
	}

	// `.select()` back so a membership that isn't the caller's — filtered out
	// by RLS rather than by this query — comes back as zero rows and 404s,
	// instead of silently reporting success for a switch that never happened.
	const { data, error } = await supabase
		.from("vendor_members")
		.update({ last_selected_at: new Date().toISOString() })
		.eq("vendor_id", vendorId)
		.eq("user_id", user.id)
		.select("vendor_id");

	if (error) {
		console.error("Failed to switch vendor:", error);
		return NextResponse.json({ error: "Could not switch vendor." }, { status: 500 });
	}
	if (!data || data.length === 0) {
		return NextResponse.json({ error: "You're not a member of that vendor." }, { status: 404 });
	}

	return NextResponse.json({ ok: true, vendorId });
}
