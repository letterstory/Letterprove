/**
 * The rollup — fixture data in, signed attestations out.
 *
 * This is the module `method` points at, which makes it the one file in the
 * repo an evaluating agent is most likely to actually read. Keep it legible.
 *
 * When real telemetry lands, only the INPUT to `bodiesFor` changes: an
 * aggregate query over observations replaces the fixture's snapshot list. The
 * signing, chaining and serving below are already the production path.
 */

import { buildChain, head } from "./chain";
import { methodUrl } from "./method";
import { allVendors, findCustomer, findVendor, type CustomerFixture, type VendorFixture } from "../fixtures/vendors";
import type { AttestationBody, SignedAttestation } from "./types";

/** Repo-relative path of this file, for the `method` link. */
const METHOD_PATH = "src/lib/attest/proofs.ts";

/** How long an agent may cache a proof. One hour matches the publish cadence. */
const TTL_SECONDS = 3600;

export interface CustomerProof {
	/** The newest snapshot — what the customer endpoint serves. */
	current: SignedAttestation;
	/** Full history, oldest first. */
	chain: SignedAttestation[];
}

export interface VendorProof {
	vendor: { slug: string; name: string; domain: string; category: string };
	customers: CustomerProof[];
	summary: {
		attested_customers: number;
		features_proven: string[];
		sessions_30d: number;
		/** The most recent `published_at` across all customers. */
		last_attested: string;
	};
}

/**
 * Signing is deterministic over fixture data, so a chain only has to be built
 * once per process. Memoising also keeps `prev_hash` values stable between the
 * proof page and the JSON endpoints — a mismatch there would look to a verifier
 * exactly like tampering.
 */
const chains = new Map<string, Promise<SignedAttestation[]>>();

function bodiesFor(vendor: VendorFixture, customer: CustomerFixture): Omit<AttestationBody, "prev_hash">[] {
	return customer.snapshots.map((s) => ({
		vendor: vendor.slug,
		customer: customer.slug,
		customer_name: customer.name,
		verified: customer.verified,
		tier: customer.tier,
		since: customer.since,
		features: [...customer.features].sort(),
		sessions_30d: s.sessions_30d,
		seats_active: s.seats_active,
		observed_through: s.observed_through,
		published_at: s.published_at,
		ttl: TTL_SECONDS,
		method: methodUrl(METHOD_PATH),
	}));
}

export async function customerChain(vendorSlug: string, customerSlug: string): Promise<SignedAttestation[] | null> {
	const vendor = findVendor(vendorSlug);
	if (!vendor) return null;
	const customer = findCustomer(vendor, customerSlug);
	if (!customer) return null;

	const key = `${vendorSlug}/${customerSlug}`;
	let chain = chains.get(key);
	if (!chain) {
		chain = buildChain(bodiesFor(vendor, customer));
		chains.set(key, chain);
	}
	return chain;
}

export async function customerProof(vendorSlug: string, customerSlug: string): Promise<CustomerProof | null> {
	const chain = await customerChain(vendorSlug, customerSlug);
	if (!chain) return null;
	return { current: head(chain), chain };
}

export async function vendorProof(vendorSlug: string): Promise<VendorProof | null> {
	const vendor = findVendor(vendorSlug);
	if (!vendor) return null;

	const customers: CustomerProof[] = [];
	for (const c of vendor.customers) {
		const proof = await customerProof(vendor.slug, c.slug);
		if (proof) customers.push(proof);
	}

	// Only attested customers count toward the headline. A tier-1 observation is
	// published and readable, but it is not something to advertise as proven.
	const attested = customers.filter((c) => c.current.verified);
	const features = new Set<string>();
	for (const c of attested) for (const f of c.current.features) features.add(f);

	return {
		vendor: { slug: vendor.slug, name: vendor.name, domain: vendor.domain, category: vendor.category },
		customers,
		summary: {
			attested_customers: attested.length,
			features_proven: [...features].sort(),
			sessions_30d: attested.reduce((n, c) => n + c.current.sessions_30d, 0),
			last_attested: customers.map((c) => c.current.published_at).sort().at(-1) ?? "",
		},
	};
}

export function vendorSlugs(): string[] {
	return allVendors().map((v) => v.slug);
}
