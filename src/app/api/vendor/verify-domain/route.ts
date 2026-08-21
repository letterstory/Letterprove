import { NextResponse } from "next/server";
import { dbClient } from "@/lib/db/client";
import { currentVendor } from "@/lib/vendors/session";
import { checkDomainVerification, verificationMessage } from "@/lib/vendors/verification";

// Node, not edge: this does a real DNS lookup.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Check the vendor's DNS for their verification record and record the result.
 *
 * Writes through the service-role client because `vendors` has no UPDATE
 * policy — deliberately, so a vendor cannot edit `domain` out from under the
 * collector's origin pin (see 20260814231500_vendor_self_signup_policies.sql).
 * This route only ever writes `domain_verified_at`, never `domain`, so that
 * intent survives: the vendor can prove control of what they claimed, not
 * change what they claimed.
 *
 * The vendor is taken from the session, never from request input — the
 * caller cannot ask us to verify somebody else's row.
 */
export async function POST() {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

	const db = dbClient();
	if (!db) return NextResponse.json({ error: "storage_unavailable" }, { status: 503 });

	const { data: row } = await db
		.from("vendors")
		.select("domain, domain_verification_token")
		.eq("id", vendor.id)
		.maybeSingle();

	if (!row?.domain_verification_token) {
		return NextResponse.json({ error: "No verification token issued for this vendor." }, { status: 409 });
	}

	const outcome = await checkDomainVerification(row.domain, row.domain_verification_token);
	const message = verificationMessage(outcome, row.domain);

	if (!outcome.verified) {
		// Deliberately does NOT clear an existing verification: a transient DNS
		// failure must not un-verify a vendor who is already proven.
		return NextResponse.json({ verified: false, message }, { status: 200 });
	}

	const { error } = await db
		.from("vendors")
		.update({ domain_verified_at: new Date().toISOString() })
		.eq("id", vendor.id);

	if (error) {
		return NextResponse.json({ error: "Verified, but couldn't save it. Try again." }, { status: 500 });
	}

	return NextResponse.json({ verified: true, message });
}
