import { retiredCustomerProof } from "@/lib/http";

/**
 * Formerly one customer's attestation. Retired on 2026-10-13 (README decision
 * 30): Letterprove attests the vendor only and names no customer. 410 for
 * every slug, with the vendor's own attestation linked. Not logged as a read:
 * nothing is served, so nothing is billed.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ vendor: string; customer: string }> }) {
	const { vendor } = await params;
	return retiredCustomerProof(vendor);
}
