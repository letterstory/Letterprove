import { logProofAccess } from "@/lib/access/log";
import { publishedVendorProof } from "@/lib/attest/proofs";
import { readingOrder } from "@/lib/attest/reading-order";
import { tierLadderDocument } from "@/lib/attest/tiers";
import { notFound, proofJson } from "@/lib/http";

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

	return proofJson({
		vendor: proof.vendor,
		summary: proof.summary,
		// The signed vendor attestation itself, so an agent that landed here
		// can verify without a second fetch. Names nobody.
		attestation: proof.attestation ? readingOrder(proof.attestation) : null,
		// Repeated from the discovery document rather than linked: the
		// attestation carries a bare `tier` integer, and an agent that landed
		// here directly would otherwise have to fetch a second document before
		// it could weight it.
		tiers: tierLadderDocument(),
	});
}
