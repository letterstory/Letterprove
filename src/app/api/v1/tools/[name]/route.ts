import { NextResponse } from "next/server";
import { authenticateOAuthRequest } from "@/lib/oauth-auth";
import { dispatchTool } from "@/lib/tools/registry";

/**
 * POST /api/v1/tools/{name} — the one seam every vendor-automation operation
 * goes through for a bearer-token caller (the CLI today; MCP can sit behind
 * the same dispatchTool later without a second implementation of any tool).
 * Body is passed straight through as the tool's args — validation is each
 * tool's own job (src/lib/tools/registry.ts), not this route's.
 */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
	const auth = await authenticateOAuthRequest(request);
	if (!auth.success) return auth.response;

	const { name } = await params;
	const args = await request.json().catch(() => ({}));

	const outcome = await dispatchTool(name, args, auth.principal);

	switch (outcome.kind) {
		case "unknown_tool":
			return NextResponse.json({ error: "unknown_tool", detail: name }, { status: 404, headers: { "cache-control": "no-store" } });
		case "denied":
			return NextResponse.json(
				{ error: "insufficient_scope", detail: outcome.capability },
				{ status: 403, headers: { "www-authenticate": `Bearer scope="${outcome.capability}"`, "cache-control": "no-store" } },
			);
		case "result": {
			const { result } = outcome;
			return NextResponse.json(result.body, {
				status: result.ok ? (result.status ?? 200) : result.status,
				headers: { "cache-control": "no-store" },
			});
		}
	}
}
