import { discoveryDocument } from "@/lib/attest/discovery";
import { llmsTxt } from "@/lib/attest/llms-txt";

/**
 * /llms.txt — the plain-text entry point agents look for first. Built from the
 * same discovery document as /.well-known/letterprove.json and /verify, so it
 * lists only published vendors and the scheme this service actually runs. See
 * lib/attest/llms-txt.ts.
 */
export async function GET(request: Request) {
	const origin = new URL(request.url).origin;
	const body = llmsTxt(await discoveryDocument(origin), origin);
	return new Response(body, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			// Same as the discovery document it is built from: an hour, with a
			// day of stale-while-revalidate. It names vendors, not customers.
			"cache-control": "public, max-age=3600, stale-while-revalidate=86400",
			"access-control-allow-origin": "*",
		},
	});
}
