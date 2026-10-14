import { logProofAccess } from "@/lib/access/log";
import { publishedVendorAggregate } from "@/lib/attest/aggregate";
import { readingOrder } from "@/lib/attest/reading-order";
import { notFound, proofJson } from "@/lib/http";
import { SNAPSHOT_CADENCE_SECONDS } from "@/lib/attest/cadence";
import { findPublishedVendor, isListed } from "@/lib/fixtures/vendors";

/**
 * A vendor's attestation — `/attest/{vendor}.json`: who the vendor is and the
 * evidence behind it, in counts. The only document Letterprove publishes about
 * a vendor (README decision 30). It names nobody.
 *
 * Public and cacheable like every other proof surface.
 *
 * There is a PUBLICATION gate, which is a different question and was missing:
 * `publishedVendorAggregate`, not `vendorAggregate`. Naming nobody is not the
 * same as saying nothing. "47 companies observed" is a fact about the vendor's
 * own business, and a vendor who has installed the collector to watch it work
 * has not thereby agreed to publish their customer count. Until they publish,
 * this 404s with the 404 an unknown vendor gets.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ vendor: string }> }
) {
	const { vendor } = await params;
	const slug = vendor.endsWith(".json") ? vendor.slice(0, -".json".length) : vendor;
	logProofAccess(request, `${slug}/aggregate`);

	const aggregate = await publishedVendorAggregate(slug);
	// Null covers an unknown vendor, an unpublished one, and telemetry we could
	// not read. The last must not publish as "0 companies observed" — a signed
	// zero is a claim, and a wrong one. The middle must be indistinguishable
	// from the first, or guessing slugs confirms who has installed us.
	if (!aggregate) return notFound(`no aggregate attestation for "${slug}"`);

	// Cached for the publishing cadence, not for a field in the body: the body
	// no longer carries a cache hint (see src/lib/attest/cadence.ts).
	const res = proofJson(readingOrder(aggregate), SNAPSHOT_CADENCE_SECONDS);
	// Unlisted (set_proof_listing): still served at this URL, never indexed.
	// A header, not a body field: listing is presentation, and the signed
	// document must be byte-identical either way.
	const v = await findPublishedVendor(slug);
	if (v && !isListed(v)) res.headers.set("x-robots-tag", "noindex, nofollow");
	return res;
}
