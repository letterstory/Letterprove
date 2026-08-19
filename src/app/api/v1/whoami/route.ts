import { NextResponse } from "next/server";
import { dbClient } from "@/lib/db/client";
import { authenticateOAuthRequest } from "@/lib/oauth-auth";

/**
 * "Which vendor is this token for?" — the first route behind Bearer auth, and
 * what `letterprove whoami` calls to prove a saved session actually works.
 *
 * It exists so the token seam is exercised by something real rather than only
 * by tests: everything else under /v1 is the public collection surface, which
 * authenticates a vendor by publishable key, not by an operator's session.
 */
export async function GET(request: Request) {
	const auth = await authenticateOAuthRequest(request);
	if (!auth.success) return auth.response;

	// A staff-only token has no vendor to look up at all.
	let vendor = null;
	if (auth.principal.vendorId) {
		const db = dbClient();
		if (!db) {
			return NextResponse.json(
				{ error: "storage_unavailable" },
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}
		({ data: vendor } = await db
			.from("vendors")
			.select("id, slug, name, domain")
			.eq("id", auth.principal.vendorId)
			.maybeSingle());
	}

	return NextResponse.json(
		{ vendor, capabilities: auth.principal.capabilities },
		// A credential-scoped answer must never be cached by anything between
		// here and the terminal that asked.
		{ headers: { "cache-control": "no-store" } },
	);
}
