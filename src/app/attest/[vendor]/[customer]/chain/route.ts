import { logProofAccess } from "@/lib/access/log";
import { customerProof } from "@/lib/attest/proofs";
import { notFound, namedProofJson } from "@/lib/http";

/**
 * A customer's full attestation history, oldest first.
 *
 * This is what makes the system auditable rather than merely signed: each entry
 * carries the hash of its predecessor, so a verifier can prove we have not
 * quietly rewritten a number we published last quarter.
 *
 * CONSENT-GATED, via `customerProof` rather than `customerChain`. The
 * distinction is the whole point of the two functions: `customerChain` is
 * deliberately ungated because the chain is always computed and always frozen
 * for every customer — that history is internal storage. `customerProof` is
 * the seam that decides whether it leaves the building. This route used to
 * call `customerChain` directly, which published a withheld customer's
 * display name and their entire signed history to anyone who appended
 * `/chain` to a URL the sibling route refuses. Every public spelling of a
 * named document has to clear the same gate, not just the shortest one.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ vendor: string; customer: string }> }
) {
	const { vendor, customer } = await params;
	logProofAccess(request, `${vendor}/${customer}/chain`);

	const proof = await customerProof(vendor, customer);
	// One 404 for an unknown vendor, an unknown customer, and a customer who
	// did not consent. They must stay indistinguishable, or guessing slugs
	// confirms that a private customer exists.
	if (!proof) return notFound(`no attestation for "${vendor}/${customer}"`);

	return namedProofJson({ vendor, customer, length: proof.chain.length, chain: proof.chain });
}
