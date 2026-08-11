import { signingKey } from "@/lib/attest/keys";
import { methodUrl } from "@/lib/attest/method";
import { vendorSlugs } from "@/lib/attest/proofs";
import { proofJson } from "@/lib/http";

/**
 * Discovery, served at /.well-known/letterprove.json.
 *
 * Everything an agent needs to go from "this host publishes proof" to a
 * verified claim, without reading our documentation: where the keys are, how
 * the bytes are canonicalised, where the verifier lives, and what is published.
 */
export async function GET(request: Request) {
	const origin = new URL(request.url).origin;
	const { isDev } = signingKey();

	return proofJson({
		name: "Letterprove",
		description: "Cryptographically attested proof of real product usage, published for evaluating agents.",
		signing: {
			alg: "EdDSA",
			crv: "Ed25519",
			jwks_uri: `${origin}/.well-known/letterprove-jwks.json`,
			canonicalization: methodUrl("src/lib/attest/canonical.ts"),
		},
		verifier: methodUrl("scripts/verify.mjs"),
		proofs: vendorSlugs().map((slug) => ({ vendor: slug, url: `${origin}/proofs/${slug}` })),
		// Said in the machine-readable surface, not only on the page: anything
		// signed by the development key is a demonstration, not evidence.
		...(isDev && {
			warning: "DEVELOPMENT DEPLOYMENT — signed with a published development key. These attestations are not evidence.",
		}),
	});
}
