import { NextResponse } from "next/server";
import { currentVendor } from "@/lib/vendors/session";
import { connectionFor, saveCredential, disconnect } from "@/lib/stripe/credentials";

/**
 * Connect and disconnect a vendor's Stripe credential.
 *
 * Scoped to the session throughout — the vendor id never comes from the
 * request, so there is no parameter a caller could change to attach a key to
 * somebody else's account.
 *
 * Nothing here ever returns key material. connectionFor() deliberately selects
 * only the last four, the mode, and sync state; the ciphertext column is not in
 * that query and no response shape carries it.
 */

/** Rejections mapped to something a person can act on, not a code. */
const REJECTION: Record<string, string> = {
	unrestricted:
		"That's a standard secret key. Please create a restricted key with read access to Customers and Subscriptions — a secret key can refund your customers, and this never needs that.",
	publishable: "That's a publishable key. It can't read subscriptions — you need a restricted key.",
	malformed: "That doesn't look like a Stripe restricted key. They start with rk_live_ or rk_test_.",
	not_configured: "Stripe connections aren't configured on this deployment yet.",
	storage_unavailable: "Couldn't save the key. Please try again.",
};

export async function POST(request: Request) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const body = await request.json().catch(() => null);
	const key = typeof body?.key === "string" ? body.key : null;
	if (!key) return NextResponse.json({ error: "A key is required." }, { status: 400 });

	const result = await saveCredential(vendor.id, key);
	if (!result.ok) {
		// 400 for a bad key, 503 when the deployment itself can't store one —
		// the vendor can fix the first and not the second.
		const status = result.reason === "not_configured" || result.reason === "storage_unavailable" ? 503 : 400;
		return NextResponse.json({ error: REJECTION[result.reason] ?? "Couldn't save that key." }, { status });
	}

	return NextResponse.json({ connection: await connectionFor(vendor.id) }, { status: 201 });
}

export async function DELETE() {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const ok = await disconnect(vendor.id);
	if (!ok) return NextResponse.json({ error: "Couldn't disconnect." }, { status: 500 });

	return NextResponse.json({ disconnected: true });
}
