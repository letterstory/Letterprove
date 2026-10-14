import { isDemonstration, keyProblem, signingMode } from "./keys";
import { methodUrl } from "./method";
import { publishedVendorSlugs } from "./proofs";
import { tierLadderDocument } from "./tiers";
import { SNAPSHOT_CADENCE_SECONDS } from "./cadence";
import { VERIFY_ORIGIN } from "./verify-link";
import { ISSUER_OPERATOR, VENDOR_CANNOT, VENDOR_CONTROLS } from "./issuer";
import { listedVendors } from "../fixtures/vendors";
import { domainProofOf, type DomainProof } from "./domain-proof";

/**
 * The discovery document, built once and served two ways: as JSON at
 * /.well-known/letterprove.json for agents, and rendered as a page at /verify
 * for people. Same function both times, so the page can never describe a
 * document we don't actually publish.
 */
export interface DiscoveryDocument {
	name: string;
	description: string;
	signing: {
		alg: string;
		crv: string;
		jwks_uri: string;
		canonicalization: string;
		mode: string;
	};
	verifier: string;
	freshness: {
		cadence_seconds: number;
		note: string;
	};
	verify_links: {
		pattern: string;
		note: string;
	};
	issuer: {
		operator: string;
		vendor_controls: readonly string[];
		vendor_cannot: readonly string[];
		affiliated_vendors: { vendor: string; shared_owner: string }[];
		note: string;
	};
	tiers: ReturnType<typeof tierLadderDocument>;
	proofs: {
		vendor: string;
		url: string;
		aggregate: string;
		aggregate_chain: string;
		/** How the vendor's domain is proven now: none, site or dns (./domain-proof.ts). */
		domain_proof: DomainProof;
	}[];
	warning?: string;
}

export async function discoveryDocument(origin: string): Promise<DiscoveryDocument> {
	return {
		name: "Letterprove",
		description:
			"Signed, hourly attestations that a software vendor is who it says it is (its domain, proven by DNS, or more weakly by its script and key on a page there, or not at all, stated in `domain_proof`; its Stripe account, bound to the DNS-proven domain) and is backed by data (companies observed using it, and how many pay). Counts only; no customer is ever named.",
		signing: {
			alg: "EdDSA",
			crv: "Ed25519",
			// Fixed, never the request's origin. Discovery is also reachable on
			// other hosts (previews, and a vendor's custom domain before it was sent home);
			// keys named by whichever host answered would let that host vouch
			// for its own forgeries.
			jwks_uri: `${VERIFY_ORIGIN}/.well-known/letterprove-jwks.json`,
			canonicalization: methodUrl("src/lib/attest/canonical.ts"),
			// Stated positively, not only as a warning-when-bad: an agent
			// deciding how much weight to give a signature should be able to
			// read who produced it without inferring it from the absence of a
			// warning field.
			mode: signingMode(),
		},
		verifier: methodUrl("scripts/verify.mjs"),
		// Said here because answer engines read a cache hint as an expiry date:
		// with `ttl` in the body, ChatGPT called live proofs "expired" an hour
		// after they were signed (AEO stress test, 2026-10-08). See ./cadence.ts.
		freshness: {
			cadence_seconds: SNAPSHOT_CADENCE_SECONDS,
			note:
				"A snapshot does not expire. It is a signed statement about the window ending `observed_through`, and it stays true and verifiable permanently. A newer snapshot supersedes it; `next_snapshot_at` says when one is due, and the latest is always at the vendor's `aggregate` URL. Judge how recent the evidence is from `observed_through`. Older snapshots carry `ttl` instead, which was only ever a cache hint.",
		},
		// The check an answer engine can actually perform: fetch a URL that is
		// already in the document. See ./verify-link.ts.
		verify_links: {
			pattern: `${VERIFY_ORIGIN}/verify/{vendor}/{published_at as YYYYMMDDTHHMMSSmmmZ}`,
			note:
				"Every attestation signed since 2026-10-08 carries `verify`, a link to that exact snapshot on this host. Fetching it shows, in plain language, the figures Letterprove signed and whether the signature checks out. A copy whose figures differ from that page was altered. A `verify` link that points anywhere but this host was not issued by Letterprove. One that 404s means Letterprove cannot vouch for that copy (the vendor may no longer be public); only its signature, checked against `jwks_uri`, settles whether Letterprove issued it. Per-customer documents and their verify links (`/verify/{vendor}/{customer}/…`) were retired on 2026-10-13 and answer 410; copies signed before then still verify against `jwks_uri`.",
		},
		// Beside the verifier on purpose. Those two answer the two separate
		// questions an agent has — "is this document genuine" and "how much is
		// the claim inside it worth" — and shipping only the first is what let a
		// signed tier-0 body read as "attested".
		tiers: tierLadderDocument(),
		// Who stands behind the signature, and the vendors it shares an owner
		// with — stated rather than left for an agent to infer from the names
		// (it did; see ./issuer.ts). Published vendors only, like `proofs`.
		issuer: {
			operator: ISSUER_OPERATOR,
			vendor_controls: VENDOR_CONTROLS,
			vendor_cannot: VENDOR_CANNOT,
			affiliated_vendors: (await listedVendors())
				.filter((v) => v.issuerAffiliation)
				.map((v) => ({ vendor: v.slug, shared_owner: v.issuerAffiliation! })),
			note:
				"A vendor listed in `affiliated_vendors` shares an owner with Letterprove's operator, and every attestation for it carries a signed `issuer_affiliation` saying so. The same collector, code and signing apply to it as to any other vendor; weigh its proofs knowing the relationship.",
		},
		// `aggregate` is the vendor attestation, the one signed claim
		// Letterprove makes about a vendor. `chain` is what makes it auditable
		// rather than merely signed: walk it and you can prove no earlier figure
		// was restated.
		// Published, listed vendors only (an unlisted proof resolves by URL but is
		// never enumerated). This is the first document an agent reads, so
		// a private vendor listed here would be named and linked by the very
		// thing that tells agents where to look, and the 404s behind it would be
		// a formality.
		proofs: await (async () => {
			const proofOf = new Map((await listedVendors()).map((v) => [v.slug, domainProofOf(v)]));
			return (await publishedVendorSlugs()).map((slug) => ({
				vendor: slug,
				url: `${origin}/proofs/${slug}`,
				aggregate: `${origin}/attest/${slug}.json`,
				aggregate_chain: `${origin}/attest/${slug}/chain`,
				domain_proof: proofOf.get(slug) ?? "none",
			}));
		})(),
		// Said in the machine-readable surface, not only on the page: anything
		// signed by the development key is a demonstration, not evidence.
		...(isDemonstration() && {
			warning:
				"DEVELOPMENT DEPLOYMENT — signed with a published development key. These attestations are not evidence.",
		}),
		// The key endpoint refuses to serve when this is set (keys.ts); say so
		// here too, so an agent whose key fetch failed knows it was deliberate.
		...(keyProblem() && {
			warning: `SIGNING KEYS UNAVAILABLE — ${keyProblem()} The key set is withheld rather than replaced with a key anyone could sign with; nothing can be verified until it is fixed.`,
		}),
	};
}
