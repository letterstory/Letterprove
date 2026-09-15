import { logProofAccess } from "@/lib/access/log";
import { publishedVendorAggregate } from "@/lib/attest/aggregate";
import { notFound, proofJson } from "@/lib/http";

/**
 * A vendor's aggregate attestation — `/attest/{vendor}.json`.
 *
 * Sits one segment above the per-customer route on purpose: this is a claim
 * about the vendor, not about any customer of theirs. It is also the only
 * signed claim most vendors can publish today, since naming a customer needs
 * that customer's consent and counting them does not.
 *
 * Public and cacheable like every other proof surface. It names nobody — the
 * whole design point — so there is no CONSENT gate here.
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

	return proofJson(aggregate, aggregate.ttl);
}
