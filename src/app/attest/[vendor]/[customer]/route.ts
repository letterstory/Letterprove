import { customerProof } from "@/lib/attest/proofs";
import { notFound, proofJson } from "@/lib/http";

/**
 * One customer's current attestation.
 *
 * The `.json` suffix is accepted and stripped: the README advertises
 * `/attest/{vendor}/{customer}.json`, and plenty of things that fetch a URL
 * cannot set an Accept header.
 */
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ vendor: string; customer: string }> }
) {
	const { vendor, customer } = await params;
	const slug = customer.endsWith(".json") ? customer.slice(0, -".json".length) : customer;

	const proof = await customerProof(vendor, slug);
	if (!proof) return notFound(`no attestation for "${vendor}/${slug}"`);

	return proofJson(proof.current, proof.current.ttl);
}
