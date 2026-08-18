import { NextResponse } from "next/server";
import { authenticateOAuthRequest } from "@/lib/oauth-auth";
import { TOOLS } from "@/lib/tools/registry";

/**
 * GET /api/v1/tools — what this credential can call, and what it needs.
 * TOOLS (src/lib/tools/registry.ts) is the only place a tool is defined, so
 * this listing can't drift from what POST /api/v1/tools/{name} actually
 * accepts.
 */
export async function GET(request: Request) {
	const auth = await authenticateOAuthRequest(request);
	if (!auth.success) return auth.response;

	const tools = TOOLS.map((t) => ({
		name: t.name,
		description: t.description,
		capability: t.capability,
		available: auth.principal.capabilities.includes(t.capability),
	}));

	return NextResponse.json({ tools }, { headers: { "cache-control": "no-store" } });
}
