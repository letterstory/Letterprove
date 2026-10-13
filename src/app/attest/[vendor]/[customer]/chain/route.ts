import { retiredCustomerProof } from "@/lib/http";

/** Formerly one customer's chain. Retired on 2026-10-13 — see ../route.ts. */
export async function GET(_request: Request, { params }: { params: Promise<{ vendor: string; customer: string }> }) {
	const { vendor } = await params;
	return retiredCustomerProof(vendor);
}
