/**
 * The rollup — identity fixtures + live telemetry + persisted history in,
 * signed attestations out.
 *
 * This is the module `method` points at, which makes it the one file in the
 * repo an evaluating agent is most likely to actually read. Keep it legible.
 */

import { attestationBody, earned, TTL_SECONDS } from "./body";
import { buildChain, head } from "./chain";
import { GENESIS_HASH, snapshotHash } from "./verify";
import { allVendors, findCustomer, findVendor, type CustomerFixture, type VendorFixture } from "../fixtures/vendors";
import { loadPersistedChain } from "@/rollup/history";
import type { SignedAttestation } from "./types";

// Re-exported for proofs.test.ts, which exercises the tier-gating rule
// directly — `earned` itself now lives in body.ts since it's shared with
// rollup/freeze.ts (the persisted path must never publish an ungated claim
// either, once frozen it's immutable).
export { earned };

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
 * The hourly freeze (rollup/freeze.ts) is what makes history durable; this
 * module only ever reads what it already wrote, plus — on top — one live
 * entry for the current hour if that hour hasn't been frozen yet. So a
 * chain is never stale by more than the freeze cadence, and never blank
 * between deploy and the first cron tick either.
 *
 * Memoising the composed result still matters for cost, and keying by hour
 * bounds staleness to TTL_SECONDS: a mismatch between the proof page and the
 * JSON endpoints within that hour would look to a verifier exactly like
 * tampering, so both must read the same cached chain, not a fresh query
 * each time.
 */
const chains = new Map<string, Promise<SignedAttestation[]>>();

function hourBucket(): number {
	return Math.floor(Date.now() / (TTL_SECONDS * 1000));
}

async function loadChain(vendor: VendorFixture, customer: CustomerFixture): Promise<SignedAttestation[]> {
	const persisted = await loadPersistedChain(vendor.slug, customer.slug);
	const bucket = hourBucket();

	if (persisted.length && persisted.at(-1)!.hourBucket === bucket) {
		return persisted.map((p) => p.attestation);
	}

	const tail = persisted.at(-1)?.attestation;
	const prevHash = tail ? snapshotHash(tail) : GENESIS_HASH;
	const body = await attestationBody(vendor, customer);
	const [fresh] = await buildChain([body], prevHash);

	return [...persisted.map((p) => p.attestation), fresh];
}

export async function customerChain(vendorSlug: string, customerSlug: string): Promise<SignedAttestation[] | null> {
	const vendor = findVendor(vendorSlug);
	if (!vendor) return null;
	const customer = findCustomer(vendor, customerSlug);
	if (!customer) return null;

	const key = `${vendorSlug}/${customerSlug}/${hourBucket()}`;
	let chain = chains.get(key);
	if (!chain) {
		chain = loadChain(vendor, customer);
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
