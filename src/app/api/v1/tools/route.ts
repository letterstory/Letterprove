import { NextResponse } from "next/server";
import { authenticateOAuthRequest } from "@/lib/oauth-auth";
import { TOOLS } from "@/lib/tools/registry";
import { toInputSchema, toOutputSchema } from "@/lib/tools/tool-schema";

/**
 * GET /api/v1/tools — what this credential can call, what it takes, and what
 * it gives back.
 *
 * TOOLS (src/lib/tools/registry.ts) is the only place a tool is defined, so
 * this listing can't drift from what POST /api/v1/tools/{name} actually
 * accepts. Both schemas are PROJECTED from the same Zod objects the registry
 * binds to each handler, rather than restated here — this route can therefore
 * never describe a tool the dispatcher wouldn't honour.
 *
 * Before this, arguments were documented in prose inside `description` and
 * return shapes were documented nowhere, so a caller had to read English to
 * learn what to send and had to call the tool to learn what came back.
 */
export async function GET(request: Request) {
	const auth = await authenticateOAuthRequest(request);
	if (!auth.success) return auth.response;

	const tools = TOOLS.map((t) => ({
		name: t.name,
		description: t.description,
		capability: t.capability,
		available: auth.principal.capabilities.includes(t.capability),
		inputSchema: toInputSchema(t.inputSchema),
		outputSchema: toOutputSchema(t.outputSchema),
	}));

	return NextResponse.json({ tools }, { headers: { "cache-control": "no-store" } });
}
