import { NextResponse } from "next/server";
import { jwksResult } from "@/lib/attest/keys";
import { proofJson } from "@/lib/http";

/**
 * Served at /.well-known/letterprove-jwks.json (rewritten in next.config.ts).
 *
 * Retired keys stay here forever. A proof issued today must still verify years
 * after the key that signed it is out of rotation — dropping one silently
 * invalidates history we have told the world is immutable.
 *
 * A 503 rather than a fallback when the production key is misconfigured: the
 * only key this service could serve instead is the development key, which
 * anyone can sign with. See keys.ts.
 */
export async function GET() {
	const result = jwksResult();
	if (!result.ok) {
		return NextResponse.json(
			{ error: "keys_unavailable", detail: result.error },
			{ status: 503, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
		);
	}
	return proofJson(result.jwks, 3600);
}
