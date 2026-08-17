import { logProofAccess } from "@/lib/access/log";
import { vendorAggregate } from "@/lib/attest/aggregate";
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
 * whole design point — so there is nothing here to gate.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ vendor: string }> }
) {
	const { vendor } = await params;
	const slug = vendor.endsWith(".json") ? vendor.slice(0, -".json".length) : vendor;
	logProofAccess(request, `${slug}/aggregate`);

	const aggregate = await vendorAggregate(slug);
	// Null covers both an unknown vendor and telemetry we could not read. The
	// second must not publish as "0 companies observed" — a signed zero is a
	// claim, and a wrong one.
	if (!aggregate) return notFound(`no aggregate attestation for "${slug}"`);

	return proofJson(aggregate, aggregate.ttl);
}
