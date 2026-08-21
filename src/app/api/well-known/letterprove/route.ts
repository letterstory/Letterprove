import { discoveryDocument } from "@/lib/attest/discovery";
import { proofJson } from "@/lib/http";

/**
 * Discovery, served at /.well-known/letterprove.json.
 *
 * Everything an agent needs to go from "this host publishes proof" to a
 * verified claim, without reading our documentation: where the keys are, how
 * the bytes are canonicalised, where the verifier lives, and what is published.
 *
 * The document itself is built in lib/attest/discovery.ts, which /verify also
 * renders for humans — one definition, so the page and the endpoint cannot
 * describe different things.
 */
export async function GET(request: Request) {
	return proofJson(await discoveryDocument(new URL(request.url).origin));
}
