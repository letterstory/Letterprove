/**
 * The rollup — identity fixtures + live telemetry in, signed attestations out.
 *
 * This is the module `method` points at, which makes it the one file in the
 * repo an evaluating agent is most likely to actually read. Keep it legible.
 */

import { buildChain, head } from "./chain";
import { methodUrl } from "./method";
import { allVendors, findCustomer, findVendor, type CustomerFixture, type VendorFixture } from "../fixtures/vendors";
import { currentSnapshot } from "@/rollup/snapshots";
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
 * `currentSnapshot` reads a live, growing table, so the chain it produces is
 * one signed entry — "as of now" — not a persisted history; there is no
 * multi-snapshot backfill yet (that needs its own storage/cadence design, not
 * just this query). Memoising still matters for cost, but keying by hour
 * bounds staleness to TTL_SECONDS instead of caching forever: a mismatch
 * between the proof page and the JSON endpoints within that hour would look
 * to a verifier exactly like tampering, so both must read the same cached
 * chain, not a fresh query each time.
 */
const chains = new Map<string, Promise<SignedAttestation[]>>();

function hourBucket(): number {
	return Math.floor(Date.now() / (TTL_SECONDS * 1000));
}

async function bodiesFor(vendor: VendorFixture, customer: CustomerFixture): Promise<Omit<AttestationBody, "prev_hash">[]> {
	const snapshot = await currentSnapshot(vendor.slug, customer.domain);
	return [
		{
			vendor: vendor.slug,
			customer: customer.slug,
			customer_name: customer.name,
			verified: customer.verified,
			tier: customer.tier,
			since: customer.since,
			features: [...customer.features].sort(),
			sessions_30d: snapshot.sessions_30d,
			seats_active: snapshot.seats_active,
			observed_through: snapshot.observed_through,
			published_at: snapshot.published_at,
			ttl: TTL_SECONDS,
			method: methodUrl(METHOD_PATH),
		},
	];
}

export async function customerChain(vendorSlug: string, customerSlug: string): Promise<SignedAttestation[] | null> {
	const vendor = findVendor(vendorSlug);
	if (!vendor) return null;
	const customer = findCustomer(vendor, customerSlug);
	if (!customer) return null;

	const key = `${vendorSlug}/${customerSlug}/${hourBucket()}`;
	let chain = chains.get(key);
	if (!chain) {
		chain = bodiesFor(vendor, customer).then(buildChain);
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
