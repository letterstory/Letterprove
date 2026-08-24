import { logProofAccess } from "@/lib/access/log";
import { vendorProof } from "@/lib/attest/proofs";
import { notFound, namedProofJson } from "@/lib/http";

/** The machine half of /proofs/{vendor} — see src/proxy.ts. */
export async function GET(request: Request, { params }: { params: Promise<{ vendor: string }> }) {
	const { vendor } = await params;
	logProofAccess(request, vendor);

	const proof = await vendorProof(vendor);
	if (!proof) return notFound(`no vendor "${vendor}"`);

	return namedProofJson({
		vendor: proof.vendor,
		summary: proof.summary,
		// The full chain is one fetch away per customer rather than inlined —
		// a vendor with 200 customers would otherwise ship a megabyte to an
		// agent that wanted one number.
		customers: proof.customers.map((c) => c.current),
	});
}
