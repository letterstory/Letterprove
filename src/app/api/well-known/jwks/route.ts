import { jwks } from "@/lib/attest/keys";
import { proofJson } from "@/lib/http";

/**
 * Served at /.well-known/letterprove-jwks.json (rewritten in next.config.ts).
 *
 * Retired keys stay here forever. A proof issued today must still verify years
 * after the key that signed it is out of rotation — dropping one silently
 * invalidates history we have told the world is immutable.
 */
export async function GET() {
	return proofJson(jwks(), 3600);
}
