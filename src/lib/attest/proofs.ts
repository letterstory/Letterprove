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
import {
	allVendors,
	consentOf,
	findCustomer,
	findPublishedVendor,
	findVendor,
	publishedVendors,
	type CustomerFixture,
	type VendorFixture,
} from "../fixtures/vendors";
import { loadPersistedChain } from "@/rollup/history";
import { tierReport } from "@/lib/tiers/report";
import type { SignedAttestation, Tier } from "./types";

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
		/**
		 * Domains that could name a company and were actually observed, but
		 * haven't crossed into `attested_customers` yet — no customer record
		 * exists for them, or one exists without consent to be named. A
		 * count only: this must never grow into per-domain detail, since
		 * that's exactly the staff-only view tierReport() already gates
		 * (see the warning on its own doc comment).
		 */
		unverified_customers: number;
		features_proven: string[];
		sessions_30d: number;
		/** The most recent `published_at` across all customers. */
		last_attested: string;
		/**
		 * Headline tier: the STRONGEST tier this vendor has earned for any
		 * attested customer (0 when none are attested). "Max attested" is a
		 * deliberate choice — it answers "how far has this vendor proven it can
		 * go", which is what a proof badge claims; it is NOT an average or a
		 * per-customer floor. If the product wants a different headline rule,
		 * this is the one line to change.
		 */
		tier: Tier;
		/** Domains observed serving in the window (tierReport's `observed`). */
		companies_observed: number;
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
 *
 * TWO CONSENTS, one door. `findPublishedVendor` rather than `findVendor`:
 * the customer has to have agreed to be named AND the vendor has to have
 * published at all. They are separate decisions by separate parties, and a
 * customer who consented before the vendor launched must not be the thing
 * that launches them. Everything else about the shape is unchanged — the
 * chain is still computed and still frozen for a private vendor, so
 * publishing is a flip, not a rebuild.
 */
export async function customerProof(vendorSlug: string, customerSlug: string): Promise<CustomerProof | null> {
	const vendor = await findPublishedVendor(vendorSlug);
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

	// Best-effort: a zero here on a telemetry hiccup understates the vendor's
	// real backlog for one page load rather than failing the whole report, and
	// self-heals on the next request. tierReport()'s own null-vs-zero rule
	// applies to the staff report it's meant for, not to this single count.
	const tiers = await tierReport(vendor.slug);

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
			unverified_customers: tiers?.unpublishedEvidence ?? 0,
			features_proven: [...features].sort(),
			sessions_30d: attested.reduce((n, c) => n + c.proof.current.sessions_30d, 0),
			last_attested: all.map((c) => c.proof.current.published_at).sort().at(-1) ?? "",
			tier: attested.length ? (Math.max(...attested.map((c) => c.proof.current.tier)) as Tier) : 0,
			companies_observed: tiers?.observed ?? 0,
		},
	};
}

/**
 * `vendorProof`, gated — what the public vendor surfaces serve.
 *
 * `vendorProof` itself stays ungated because it is also internal composition:
 * `get_proof_summary` is a vendor reading their own rollup back through a
 * token scoped to their own vendor id, which is not publication and must keep
 * working while they are private. Same split, same reasoning, and the same
 * naming as `customerChain` / `customerProof` above — the gated door has a
 * different name so the call site says which one it opened.
 */
export async function publishedVendorProof(vendorSlug: string): Promise<VendorProof | null> {
	if (!(await findPublishedVendor(vendorSlug))) return null;
	return vendorProof(vendorSlug);
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
	return (await publishedVendors()).map((v) => v.slug);
}

export interface CustomerSnapshotSummary {
	slug: string;
	length: number;
	current: { published_at: string; verified: boolean; sessions_30d: number; features: string[] };
}

/**
 * The vendor's own view of their customers' attestation chains — unlike
 * vendorProof, deliberately NOT consent-gated. Consent governs what leaves
 * the building publicly; this is the vendor reading their own data back
 * through a bearer token they hold for their own vendor_id, the same trust
 * boundary as list_customers.
 */
export async function vendorSnapshots(vendorSlug: string, customerSlug?: string): Promise<CustomerSnapshotSummary[] | null> {
	const vendor = await findVendor(vendorSlug);
	if (!vendor) return null;

	const customers = customerSlug ? vendor.customers.filter((c) => c.slug === customerSlug) : vendor.customers;

	const out: CustomerSnapshotSummary[] = [];
	for (const c of customers) {
		const chain = await customerChain(vendorSlug, c.slug);
		if (!chain || chain.length === 0) continue;
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
