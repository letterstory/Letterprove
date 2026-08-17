import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth/server";
import { vendorSlugs } from "@/lib/attest/proofs";
import { tierReport } from "@/lib/tiers/report";

/**
 * `GET /api/staff/tiers` — why every claim is at the tier it is.
 *
 * Answers, per vendor and per domain, the question that currently takes a
 * Supabase query and a fixture read: what have we observed, who is on record,
 * and what is stopping each one from being a published claim.
 *
 * **Staff-only, and the gate is load-bearing.** The body names customer
 * domains, including ones deliberately withheld for consent and ones that are
 * unattributable — publishing this openly would leak exactly what the consent
 * design exists to protect. Uses `getUser()`, which revalidates the token with
 * the auth server; a session-decoding check would not be a gate.
 *
 * Signed-out and auth-not-configured both return 404 rather than 401,
 * following the same reasoning as the proof endpoints: an internal surface
 * that confirms its own existence to anyone who guesses the URL is telling
 * people where to push.
 *
 * Nothing here is signed and nothing reaches an attestation — it reads data
 * that already exists and states what the publishing rules will do with it.
 */
export async function GET(request: Request) {
	const user = await getUser();
	if (!user) return NextResponse.json({ error: "not_found" }, { status: 404 });

	const requested = new URL(request.url).searchParams.get("vendor");
	const slugs = requested ? [requested] : await vendorSlugs();

	const reports = await Promise.all(slugs.map((slug) => tierReport(slug)));

	// A null report means the vendor is unknown OR its telemetry could not be
	// read, and those must not be flattened into "no evidence" — see
	// tierReport's own note. Say which vendors could not be reported on.
	const unreadable = slugs.filter((_, i) => reports[i] === null);

	return NextResponse.json(
		{
			generated_at: new Date().toISOString(),
			vendors: reports.filter((r) => r !== null),
			...(unreadable.length > 0 && { unreadable }),
		},
		{ headers: { "cache-control": "no-store" } },
	);
}
