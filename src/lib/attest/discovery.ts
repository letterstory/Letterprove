import { isDemonstration, signingMode } from "./keys";
import { methodUrl } from "./method";
import { publishedVendorSlugs } from "./proofs";
import { tierLadderDocument } from "./tiers";
import { SNAPSHOT_CADENCE_SECONDS } from "./cadence";
import { VERIFY_ORIGIN } from "./verify-link";

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
			"Cryptographically attested proof of real product usage, published for evaluating agents.",
		signing: {
			alg: "EdDSA",
			crv: "Ed25519",
			jwks_uri: `${origin}/.well-known/letterprove-jwks.json`,
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
			pattern: `${VERIFY_ORIGIN}/verify/{vendor}[/{customer}]/{published_at as YYYYMMDDTHHMMSSmmmZ}`,
			note:
				"Every attestation signed since 2026-10-08 carries `verify`, a link to that exact snapshot on this host. Fetching it shows, in plain language, the figures Letterprove signed and whether the signature checks out. A copy whose figures differ from that page was altered; a `verify` link that 404s, or that points anywhere but this host, means the document was not issued by Letterprove.",
		},
		// Beside the verifier on purpose. Those two answer the two separate
		// questions an agent has — "is this document genuine" and "how much is
		// the claim inside it worth" — and shipping only the first is what let a
		// signed tier-0 body read as "attested".
		tiers: tierLadderDocument(),
		// The aggregate is listed beside the report on purpose. It is the only
		// claim most vendors will ever publish — naming a customer needs that
		// customer's consent — so an agent that only found `report` would miss
		// the one thing that is actually signed for them. `chain` is what makes
		// it auditable rather than merely signed: walk it and you can prove no
		// earlier figure was restated.
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
	};
}
