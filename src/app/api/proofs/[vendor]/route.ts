import { logProofAccess } from "@/lib/access/log";
import { publishedVendorProof } from "@/lib/attest/proofs";
import { tierLadderDocument } from "@/lib/attest/tiers";
import { notFound, namedProofJson } from "@/lib/http";

/**
 * The machine half of /proofs/{vendor} — see src/proxy.ts.
 *
 * `publishedVendorProof`, not `vendorProof`: this is the same document the
 * HTML page serves, so it has to clear the same publication gate. The page
 * 404s in its layout; this would otherwise have answered 200 with the whole
 * summary to anyone who sent an `Accept: application/json`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ vendor: string }> }) {
	const { vendor } = await params;
	logProofAccess(request, vendor);

	const proof = await publishedVendorProof(vendor);
	if (!proof) return notFound(`no vendor "${vendor}"`);

	return namedProofJson({
		vendor: proof.vendor,
		summary: proof.summary,
		// The full chain is one fetch away per customer rather than inlined —
		// a vendor with 200 customers would otherwise ship a megabyte to an
		// agent that wanted one number.
		customers: proof.customers.map((c) => c.current),
		// Repeated from the discovery document rather than linked. Every entry
		// above carries a bare `tier` integer, and an agent that landed here
		// directly — which is what the proof URL is for — would otherwise have
		// to know to fetch a second document before it could weight any of
		// them. Costs a few hundred bytes; saves a claim being misread as
		// stronger than it is.
		tiers: tierLadderDocument(),
	});
}
