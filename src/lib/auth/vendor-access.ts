/**
 * Route authorization for the Letterstory-unified world.
 *
 * Every Letterprove API route that serves vendor-scoped data to Letterstory
 * funnels through here. In the unified model Letterprove holds no identity and
 * no membership of its own: Letterstory's backend authenticates the user and
 * authorizes their org membership (its own src/lib/api-auth.ts) BEFORE calling,
 * then calls this service as a trusted peer. So this seam does two things and
 * only two:
 *
 *   1. Prove the caller is Letterstory's backend — a shared service secret
 *      (LETTERSTORY_API_SECRET), the same Bearer pattern CRON_SECRET uses.
 *   2. Resolve the (now-trusted) org id to the vendor it is, 1:1, via
 *      findVendorByOrg (letterstory_org_id, see migration 20260825060000).
 *
 * It deliberately does NOT re-check membership or role — that check already
 * happened in Letterstory, and duplicating it here would need LP to reach back
 * into LS's user pool, the exact coupling the service-secret model avoids.
 * LP's own business rules (consent-domain binding, tiering) still live in the
 * route handlers; this only governs "is this a real Letterstory call, for a
 * vendor that exists". Fails closed everywhere.
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { findVendorByOrg } from "@/lib/fixtures/vendors";
import type { VendorFixture } from "@/lib/fixtures/vendors";

/** Constant-time string compare that never short-circuits on length. */
function secretsMatch(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * True when the request carries the shared Letterstory service secret as
 * `Authorization: Bearer <secret>`. Unconfigured (no LETTERSTORY_API_SECRET)
 * returns false — the seam admits no one rather than running open.
 */
export function isLetterstoryCaller(request: Request): boolean {
	const secret = process.env.LETTERSTORY_API_SECRET;
	if (!secret) return false;
	const header = request.headers.get("authorization");
	if (!header) return false;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!match) return false;
	return secretsMatch(match[1].trim(), secret);
}

export type VendorScope =
	| { ok: true; vendor: VendorFixture }
	| { ok: false; response: NextResponse };

function deny(message: string, status: number): { ok: false; response: NextResponse } {
	return { ok: false, response: NextResponse.json({ error: message }, { status }) };
}

/**
 * The primitive every vendor-scoped Letterprove API route calls: authenticate
 * the Letterstory service caller, then resolve the trusted org id to its vendor.
 * On success returns the vendor; on any failure returns a ready NextResponse.
 *
 * A 404 for an org with no vendor is a real state, not an error — linking is
 * deliberate and there is no auto-provisioning, so the Letterstory setup flow
 * reads it as "offer to create one" (see findVendorByOrg).
 */
export async function resolveVendorForOrg(request: Request, orgId: string): Promise<VendorScope> {
	if (!isLetterstoryCaller(request)) return deny("Unauthorized", 401);
	if (!orgId) return deny("org_id is required", 400);

	const vendor = await findVendorByOrg(orgId);
	if (!vendor) return deny("No Letterprove vendor for this organization", 404);

	return { ok: true, vendor };
}
