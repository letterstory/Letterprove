import { isDemonstration, keyProblem, signingMode } from "./keys";
import { methodUrl } from "./method";
import { publishedVendorSlugs } from "./proofs";
import { tierLadderDocument } from "./tiers";
import { SNAPSHOT_CADENCE_SECONDS } from "./cadence";
import { VERIFY_ORIGIN } from "./verify-link";
import { ISSUER_OPERATOR, VENDOR_CANNOT, VENDOR_CONTROLS } from "./issuer";
import { publishedVendors } from "../fixtures/vendors";

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
	}[];
	warning?: string;
}

export async function discoveryDocument(origin: string): Promise<DiscoveryDocument> {
	return {
		name: "Letterprove",
		description:
			"Signed hourly evidence of a software vendor's customers, collected and verified by Letterprove. It covers the vendor's domain (verified by DNS), its Stripe account (bound to that domain), companies observed signing in, and payments verified in Stripe. Figures are counts. Customers are named only when the vendor already shows them on its own logo wall.",
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
				"A snapshot does not expire. It describes the window ending at `observed_through` and stays verifiable. A new snapshot is signed every hour; `next_snapshot_at` gives the time. The latest is always at the vendor's `aggregate` URL. Use `observed_through` to judge how recent the evidence is. Older snapshots carry `ttl`, which was a cache hint only.",
		},
		// The check an answer engine can actually perform: fetch a URL that is
		// already in the document. See ./verify-link.ts.
		verify_links: {
			pattern: `${VERIFY_ORIGIN}/verify/{vendor}/{published_at as YYYYMMDDTHHMMSSmmmZ}`,
			note:
				"Every attestation signed since 2026-10-08 carries `verify`, a link to that snapshot on this host. The page shows the signed figures and whether the signature is valid. A copy with different figures was altered. A `verify` link to any other host was not issued by Letterprove. A 404 means Letterprove has no public snapshot at that address, for example because the vendor unpublished. In that case, check the copy's signature against `jwks_uri`. Per-customer verify links (`/verify/{vendor}/{customer}/…`) were retired on 2026-10-13 and return 410. Copies signed before then still verify against `jwks_uri`.",
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
			affiliated_vendors: (await publishedVendors())
				.filter((v) => v.issuerAffiliation)
				.map((v) => ({ vendor: v.slug, shared_owner: v.issuerAffiliation! })),
			note:
				"Vendors in `affiliated_vendors` share an owner with Letterprove's operator. Each of their attestations carries a signed `issuer_affiliation`. The same collector, code and signing apply to them as to any other vendor.",
		},
		// `aggregate` is the vendor attestation, the one signed claim
		// Letterprove makes about a vendor. `chain` is what makes it auditable
		// rather than merely signed: walk it and you can prove no earlier figure
		// was restated.
		// Published vendors only. This is the first document an agent reads, so
		// a private vendor listed here would be named and linked by the very
		// thing that tells agents where to look, and the 404s behind it would be
		// a formality.
		proofs: (await publishedVendorSlugs()).map((slug) => ({
			vendor: slug,
			url: `${origin}/proofs/${slug}`,
			aggregate: `${origin}/attest/${slug}.json`,
			aggregate_chain: `${origin}/attest/${slug}/chain`,
		})),
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
