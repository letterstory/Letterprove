import { isDemonstration, signingMode } from "./keys";
import { methodUrl } from "./method";
import { vendorSlugs } from "./proofs";

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
		// The aggregate is listed beside the report on purpose. It is the only
		// claim most vendors will ever publish — naming a customer needs that
		// customer's consent — so an agent that only found `report` would miss
		// the one thing that is actually signed for them. `chain` is what makes
		// it auditable rather than merely signed: walk it and you can prove no
		// earlier figure was restated.
		proofs: (await vendorSlugs()).map((slug) => ({
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
