/**
 * The install snippet a vendor copies out of their dashboard.
 *
 * Derived from the origin actually serving the page rather than written down,
 * because a hardcoded host is a silent outage waiting to happen. It already
 * happened twice:
 *
 *   - Lettertrace's install pointed at `letterprove.vercel.app` after the
 *     domain move. It 404'd for 65 hours and nothing noticed, because a broken
 *     install and a quiet weekend produce the same event count.
 *   - The dashboard handed every vendor `https://cdn.letterprove.com/attest.js`.
 *     That host has never existed. attest.js is a static file in `public/`, so
 *     it is served by this app at this app's origin and nowhere else.
 *
 * The failure is silent by design elsewhere in the system: attest.js must never
 * break a host page, so a 404 on the script is indistinguishable from a site
 * with no traffic. That makes "point at the wrong host" uniquely expensive —
 * the vendor sees an empty dashboard and concludes the product does not work.
 *
 * Deriving it means the snippet is correct on localhost, on a preview
 * deployment, and in production without anyone remembering to update a
 * constant.
 */

/** The path attest.js is served from — `public/attest.js`, hence the root. */
export const ATTEST_SCRIPT_PATH = "/attest.js";

export function installSnippet(origin: string, publishableKey: string): string {
	return `<script src="${origin}${ATTEST_SCRIPT_PATH}" data-key="${publishableKey}"></script>`;
}

/**
 * The origin to build the snippet against, from the request's own headers.
 *
 * `x-forwarded-*` first: behind Vercel's proxy `host` is the internal hostname,
 * and a snippet pointing at that would be worse than useless. Falls back to
 * `host` for local `next start`, where no proxy sets the forwarded pair.
 */
export function originFromHeaders(headers: Headers): string | null {
	const host = headers.get("x-forwarded-host") ?? headers.get("host");
	if (!host) return null;
	const proto = headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
	return `${proto}://${host}`;
}

/** Where a vendor's server forwards agent and crawler requests — see src/app/api/v1/agent-visit. */
export const AGENT_VISIT_PATH = "/api/v1/agent-visit";

/**
 * The optional second install line: a few lines in the vendor's own server
 * that forward each request's user-agent, address and path. Needed because
 * ChatGPT, Claude, Perplexity and the search crawlers fetch HTML without
 * running JavaScript, so the script tag never sees them.
 *
 * Fire-and-forget on purpose. The forward must never slow or fail the
 * vendor's page: no await on the response, keepalive so it survives the
 * request ending, and every error swallowed. The endpoint drops browsers
 * itself; the pre-filter in the snippets only saves requests.
 */
export function serverSnippets(
	origin: string,
	publishableKey: string,
): { endpoint: string; nextjs_middleware: string; generic: string } {
	const endpoint = `${origin}${AGENT_VISIT_PATH}`;
	const nextjs = `// middleware.ts (proxy.ts on Next 16) — counts AI agents and crawlers that never run JavaScript.
import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
	const ua = request.headers.get("user-agent") ?? "";
	if (/bot|crawler|spider|chatgpt|claude|perplexity|anthropic/i.test(ua) || request.headers.has("signature-agent")) {
		fetch("${endpoint}", {
			method: "POST",
			keepalive: true,
			body: JSON.stringify({
				k: "${publishableKey}",
				ua,
				ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
				path: request.nextUrl.pathname,
				host: request.nextUrl.hostname,
				signature_agent: request.headers.get("signature-agent"),
			}),
		}).catch(() => {});
	}
	return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/|favicon.ico).*)"] };`;
	const generic = `// Any Node server: call once per request, never await it.
function forwardAgentVisit(req) {
	fetch("${endpoint}", {
		method: "POST",
		keepalive: true,
		body: JSON.stringify({
			k: "${publishableKey}",
			ua: req.headers["user-agent"] ?? "",
			ip: req.ip ?? null,
			path: req.path ?? req.url,
			host: req.hostname ?? null,
			signature_agent: req.headers["signature-agent"] ?? null,
		}),
	}).catch(() => {});
}`;
	return { endpoint, nextjs_middleware: nextjs, generic };
}
