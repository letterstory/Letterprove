import { logProofAccess } from "@/lib/access/log";
import { customerChain } from "@/lib/attest/proofs";
import { notFound, namedProofJson } from "@/lib/http";

/**
 * A customer's full attestation history, oldest first.
 *
 * This is what makes the system auditable rather than merely signed: each entry
 * carries the hash of its predecessor, so a verifier can prove we have not
 * quietly rewritten a number we published last quarter.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ vendor: string; customer: string }> }
) {
	const { vendor, customer } = await params;
	logProofAccess(request, `${vendor}/${customer}/chain`);

	const chain = await customerChain(vendor, customer);
	if (!chain) return notFound(`no attestation for "${vendor}/${customer}"`);

	return namedProofJson({ vendor, customer, length: chain.length, chain });
}
