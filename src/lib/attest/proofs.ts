import { domainProofOf, type DomainProof } from "./domain-proof";
/**
 * The vendor proof — what `/proofs/{vendor}` and `/api/proofs/{vendor}` serve,
 * and what `get_proof_summary` reads back to the vendor.
 *
 * One vendor, one signed attestation (./aggregate.ts): who the vendor is and
 * what backs it, in counts. No customer is named anywhere in it. Per-customer
 * documents were retired on 2026-10-13 (README decision 30); their frozen
 * history stays in the database, readable by the vendor through
 * `list_snapshots`, and their public URLs answer 410.
 *
 * This is the module `method` points at for the summary, which makes it one of
 * the files an evaluating agent is most likely to read. Keep it legible.
 */

import { earned } from "./body";
import { head } from "./chain";
import { publishedVendorAggregate, vendorAggregate, type SignedAggregate } from "./aggregate";
import { allVendors, findPublishedVendor, findVendor, listedVendors } from "../fixtures/vendors";
import { loadPersistedChain } from "@/rollup/history";
import type { Tier } from "./types";

export { earned };

export interface VendorProof {
	vendor: {
		slug: string;
		name: string;
		domain: string;
		category: string;
		/** The owner this vendor shares with Letterprove's operator, or null — see ./issuer.ts. */
		issuer_affiliation: string | null;
		/** How the domain is proven NOW (./domain-proof.ts). The signed document carries its own `domain_proof`. */
		domain_proof: DomainProof;
	};
	/** The newest signed vendor attestation, or null before the first hourly freeze. */
	attestation: SignedAggregate | null;
	summary: {
		/** The attestation's tier: the strongest evidence class present (decision 30). */
		tier: Tier;
		/** Company domains observed signing in over the last 30 days. */
		companies_observed: number;
		/** Whether Stripe has verified the business behind the vendor's own Stripe account (`stripe_business.verified`). */
		business_verified: boolean;
		sessions_30d: number;
		/** When the newest attestation was signed, or "" before the first one. */
		last_attested: string;
	};
}

function toProof(
	vendor: NonNullable<Awaited<ReturnType<typeof findVendor>>>,
	attestation: SignedAggregate | null,
): VendorProof {
	return {
		vendor: {
			slug: vendor.slug,
			name: vendor.name,
			domain: vendor.domain,
			category: vendor.category,
			issuer_affiliation: vendor.issuerAffiliation,
			domain_proof: domainProofOf(vendor),
		},
		attestation,
		summary: {
			tier: attestation?.tier ?? 0,
			companies_observed: attestation?.companies_observed ?? 0,
			business_verified: attestation?.stripe_business?.verified === true,
			sessions_30d: attestation?.sessions ?? 0,
			last_attested: attestation?.published_at ?? "",
		},
	};
}

/**
 * The vendor's own proof, whether or not it is public. `get_proof_summary` is
 * a vendor reading their own attestation back through a token scoped to their
 * vendor id, which is not publication and must keep working while private.
 */
export async function vendorProof(vendorSlug: string): Promise<VendorProof | null> {
	const vendor = await findVendor(vendorSlug);
	if (!vendor) return null;
	return toProof(vendor, await vendorAggregate(vendorSlug));
}

/**
 * `vendorProof`, gated — what the public vendor surfaces serve. Null for an
 * unpublished vendor, exactly as for an unknown one.
 */
export async function publishedVendorProof(vendorSlug: string): Promise<VendorProof | null> {
	const vendor = await findPublishedVendor(vendorSlug);
	if (!vendor) return null;
	return toProof(vendor, await publishedVendorAggregate(vendorSlug));
}

export async function vendorSlugs(): Promise<string[]> {
	return (await allVendors()).map((v) => v.slug);
}

/**
 * The slugs a stranger may be told about.
 *
 * Discovery (/.well-known/letterprove.json) enumerates these. A private
 * vendor listed there would be named, and linked to, by the one document
 * agents are told to read first — which would make the 404s on its routes a
 * formality rather than a gate.
 */
export async function publishedVendorSlugs(): Promise<string[]> {
	// Listed only: an unlisted vendor's proof resolves by URL but is never
	// enumerated here.
	return (await listedVendors()).map((v) => v.slug);
}

export interface CustomerSnapshotSummary {
	slug: string;
	length: number;
	current: { published_at: string; verified: boolean; sessions_30d: number; features: string[] };
}

/**
 * The vendor's own history of the retired per-customer chains, frozen up to
 * 2026-10-13. Vendor-private (same trust boundary as list_customers) and
 * read-only: nothing is signed or appended here any more.
 */
export async function vendorSnapshots(vendorSlug: string, customerSlug?: string): Promise<CustomerSnapshotSummary[] | null> {
	const vendor = await findVendor(vendorSlug);
	if (!vendor) return null;

	const customers = customerSlug ? vendor.customers.filter((c) => c.slug === customerSlug) : vendor.customers;

	const out: CustomerSnapshotSummary[] = [];
	for (const c of customers) {
		const chain = (await loadPersistedChain(vendorSlug, c.slug)).map((p) => p.attestation);
		if (chain.length === 0) continue;
		const current = head(chain);
		out.push({
			slug: c.slug,
			length: chain.length,
			current: {
				published_at: current.published_at,
				verified: current.verified,
				sessions_30d: current.sessions_30d,
				features: current.features,
			},
		});
	}
	return out;
}
