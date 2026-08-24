import { NextResponse } from "next/server";
import { currentVendor } from "@/lib/vendors/session";
import { tierReport } from "@/lib/tiers/report";
import { promoteDomain } from "@/lib/staff/promote";

/**
 * The companies a vendor has been observed serving, and the one action they
 * can take about it.
 *
 * This closes the hole that made the product unable to work without us. Both
 * halves of the core loop — seeing which companies were observed, and turning
 * one into a customer record — existed only under /staff. A vendor could sign
 * up, install the script, generate real evidence from dozens of companies, and
 * have no way to see any of it or act on it. Their proof page read zero
 * forever unless somebody at Letterstory did it for them by hand, which does
 * not scale past a handful of design partners.
 *
 * /privacy §4 already told vendors this view existed: "the per-domain view
 * exists only inside the vendor's own dashboard and our internal staff tools."
 * The staff half was true. This is the other half.
 *
 * SCOPING IS THE WHOLE SECURITY STORY HERE. The staff report takes a vendor
 * slug and will happily report on any of them. Every route below derives the
 * slug from the SESSION and never from the request, so there is no parameter
 * a caller could change to read another vendor's customer list. That is also
 * why this is a separate route from the staff one rather than the same handler
 * with a role check: the staff version's whole contract is "any vendor", and
 * sharing it would put one `if` between a vendor and everyone else's data.
 */

/** GET /api/vendor/observed — the signed-in vendor's own observed domains. */
export async function GET() {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const report = await tierReport(vendor.slug);
	if (!report) {
		// A failed telemetry read is NOT "no companies observed". Saying so
		// would tell a vendor their install is broken when it may be fine.
		return NextResponse.json({ error: "Couldn't read your telemetry." }, { status: 503 });
	}

	return NextResponse.json({
		observed: report.observed,
		attributable: report.attributable,
		awaiting: report.unpublishedEvidence,
		published: report.published,
		domains: report.rows.map((row) => ({
			domain: row.domain,
			kind: row.kind,
			events: row.sessions + row.signups + row.logins,
			sessions: row.sessions,
			signups: row.signups,
			logins: row.logins,
			customer: row.customer,
			status: row.status,
			detail: row.detail,
		})),
	});
}

/**
 * POST /api/vendor/observed — record one observed domain as a customer.
 *
 * Same rules as the staff path, because it is literally the same function:
 * always anonymous, never named; the domain must actually have been observed;
 * tier and verified are ceilings the attest pipeline re-derives. A vendor
 * cannot use this to invent a customer, which is the point — it turns evidence
 * we already hold into a record, and nothing more.
 */
export async function POST(request: Request) {
	const vendor = await currentVendor();
	if (!vendor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

	const body = await request.json().catch(() => null);
	const domain = typeof body?.domain === "string" ? body.domain : null;
	if (!domain) return NextResponse.json({ error: "domain is required" }, { status: 400 });

	// vendor.slug, never a slug from the body — the session is the only thing
	// that decides whose data this touches.
	const result = await promoteDomain(vendor.slug, domain);
	if (!result.ok) {
		const status = result.reason === "already_exists" ? 409 : 400;
		return NextResponse.json({ error: result.detail, reason: result.reason }, { status });
	}

	return NextResponse.json(
		{ customer: { slug: result.slug, name: result.name, domain: result.domain } },
		{ status: 201 }
	);
}
