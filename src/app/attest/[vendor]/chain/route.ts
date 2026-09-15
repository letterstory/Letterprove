import { logProofAccess } from "@/lib/access/log";
import { publishedVendorAggregateChain } from "@/lib/attest/aggregate";
import { notFound, proofJson } from "@/lib/http";

/**
 * A vendor's full aggregate history — `/attest/{vendor}/chain`.
 *
 * The counterpart to `/attest/{vendor}/{customer}/chain`, and the thing that
 * makes the vendor-level claim auditable rather than merely signed: each entry
 * carries the hash of its predecessor, so a verifier can prove we have not
 * quietly restated last month's numbers.
 *
 * RESERVED SLUG. This is a static segment sitting beside `[customer]`, and
 * Next resolves static before dynamic — so a customer slugged "chain" would be
 * unreachable at `/attest/{vendor}/chain`. That slug is refused at customer
 * creation for exactly this reason (see api/vendor/customers), rather than
 * left to be discovered when someone's proof silently 404s.
 *
 * Names nobody, so no consent gate — but publication-gated all the same, via
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

	return proofJson({ vendor, kind: "aggregate", length: chain.length, chain });
}
