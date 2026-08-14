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
import { allVendors, consentOf, findCustomer, findVendor, type CustomerFixture, type VendorFixture } from "../fixtures/vendors";
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
		/** Of `attested_customers`, how many are withheld pending consent. */
		attested_unnamed: number;
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
	// The live path deliberately ignores `snapshot.readOk`: this entry is
	// recomputed every hour and never persisted, so a failed read degrades one
	// hour's published claim and then self-heals. freeze.ts, which writes an
	// immutable row, must not be so relaxed.
	const { body } = await attestationBody(vendor, customer);
	const [fresh] = await buildChain([body], prevHash);

	return [...persisted.map((p) => p.attestation), fresh];
}

export async function customerChain(vendorSlug: string, customerSlug: string): Promise<SignedAttestation[] | null> {
	const vendor = await findVendor(vendorSlug);
	if (!vendor) return null;
	const customer = findCustomer(vendor, customerSlug);
	if (!customer) return null;

	const key = `${vendorSlug}/${customerSlug}/${hourBucket()}`;
	let chain = chains.get(key);
	if (!chain) {
		chain = loadChain(vendor, customer);
		// Evict a rejected load so the next request retries. Without this the
		// failed promise stays memoised for the rest of the hour, turning one
		// transient history-read error into an hour of 500s long after the
		// datastore recovered.
		chain.catch(() => chains.delete(key));
		chains.set(key, chain);
	}
	return chain;
}

/**
 * One customer's published attestation — **null unless they consented to be
 * named.**
 *
 * This is the seam that makes "build named, ship anonymized" real. The chain
 * itself is always computed and always frozen: `rollup/freeze.ts` writes the
 * full named history for every customer, because that history is internal
 * storage, not publication. What consent gates is whether it *leaves the
 * building*.
 *
 * The consequence worth noticing is that flipping a customer to `named` needs
 * no backfill and no re-signing — their entire signed history becomes
 * publishable at once, already chained. That is precisely what "flip as
 * consent lands" has to mean to be more than a slogan.
 *
 * Withholding is a 404 rather than a redacted document on purpose: a
 * pseudonymous attestation still says "some customer of this vendor did X",
 * and against a vendor with three customers that re-identifies trivially.
 * Anonymous customers contribute to the aggregate and nothing else.
 */
export async function customerProof(vendorSlug: string, customerSlug: string): Promise<CustomerProof | null> {
	const vendor = await findVendor(vendorSlug);
	const customer = vendor && findCustomer(vendor, customerSlug);
	if (!customer || consentOf(customer) !== "named") return null;

	const chain = await customerChain(vendorSlug, customerSlug);
	if (!chain) return null;
	return { current: head(chain), chain };
}

export async function vendorProof(vendorSlug: string): Promise<VendorProof | null> {
	const vendor = await findVendor(vendorSlug);
	if (!vendor) return null;

	// Every customer is counted; only consenting ones are listed. README §
	// Consent: aggregate proof ("12 attested customers, 4 features proven, 38k
	// sessions/mo") carries almost no consent problem and is already
	// meaningfully better than a logo wall — it is the naming that needs
	// permission. So the summary reads from all of them and `customers` from
	// the named subset, and this uses customerChain (ungated) rather than
	// customerProof (gated) to get there.
	const all: { proof: CustomerProof; named: boolean }[] = [];
	for (const c of vendor.customers) {
		const chain = await customerChain(vendor.slug, c.slug);
		if (!chain) continue;
		all.push({ proof: { current: head(chain), chain }, named: consentOf(c) === "named" });
	}

	// Only attested customers count toward the headline. A tier-1 observation is
	// published and readable, but it is not something to advertise as proven.
	const attested = all.filter((c) => c.proof.current.verified);
	const features = new Set<string>();
	for (const c of attested) for (const f of c.proof.current.features) features.add(f);

	return {
		vendor: { slug: vendor.slug, name: vendor.name, domain: vendor.domain, category: vendor.category },
		customers: all.filter((c) => c.named).map((c) => c.proof),
		summary: {
			attested_customers: attested.length,
			// How much of the headline is standing behind a consent wall. Published
			// so the aggregate can't be mistaken for the full list of customers —
			// an agent that sees "3 attested" and one named entry should be able to
			// tell that the other two were withheld, not that we miscounted.
			attested_unnamed: attested.filter((c) => !c.named).length,
			features_proven: [...features].sort(),
			sessions_30d: attested.reduce((n, c) => n + c.proof.current.sessions_30d, 0),
			last_attested: all.map((c) => c.proof.current.published_at).sort().at(-1) ?? "",
		},
	};
}

export async function vendorSlugs(): Promise<string[]> {
	return (await allVendors()).map((v) => v.slug);
}
