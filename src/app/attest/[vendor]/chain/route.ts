import { logProofAccess } from "@/lib/access/log";
import { readingOrder } from "@/lib/attest/reading-order";
import { publishedVendorAggregateChain } from "@/lib/attest/aggregate";
import { notFound, proofJson } from "@/lib/http";

/**
 * A vendor's full attestation history — `/attest/{vendor}/chain`.
 *
 * The thing that makes the vendor claim auditable rather than merely signed: each entry
 * carries the hash of its predecessor, so a verifier can prove we have not
 * quietly restated last month's numbers.
 *
 * A static segment beside the retired `[customer]` route; Next resolves static
 * before dynamic.
 *
 * Names nobody, but publication-gated, via
 * `publishedVendorAggregateChain`. The history is built and frozen for a
 * private vendor exactly as for a public one; what publication decides is
 * whether it leaves the building. That is what makes going public a flip
 * rather than a rebuild.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ vendor: string }> }
) {
	const { vendor } = await params;
	logProofAccess(request, `${vendor}/aggregate/chain`);

	const chain = await publishedVendorAggregateChain(vendor);
	// Null covers an unknown vendor, an unpublished one, and an unreadable
	// telemetry read alike. None should publish as an empty history, which
	// would read as "this vendor has never claimed anything".
	if (!chain) return notFound(`no aggregate history for "${vendor}"`);

	return proofJson({ vendor, kind: "aggregate", length: chain.length, chain: chain.map(readingOrder) });
}
