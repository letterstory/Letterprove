import { NextResponse, type NextRequest } from "next/server";
import { VERIFY_ORIGIN } from "@/lib/attest/verify-link";
import { isOwnHost, slugForCustomDomain } from "@/lib/vendors/custom-domain";

/**
 * NOTE THE FILE NAME. Next 16 deprecated `middleware.ts` in favour of
 * `proxy.ts`, matching lettersprite. The export name follows the convention.
 *
 * Now that Letterprove holds no identity of its own — its dashboard, login, and
 * OAuth server are retired and Letterstory is the sole identity authority — the
 * only concern left at this entry point is content negotiation for the public
 * proof surface:
 *
 *   /proofs/{vendor} serves a human page by default, but the same URL with a
 *   `.json` suffix or an explicit JSON `Accept` (and no HTML alternative) is
 *   rewritten to the machine endpoint at /api/proofs/{vendor}. Agents fetch
 *   exactly what they always did.
 *
 * And one more: a vendor's custom proof domain (proof.acme.com) serves that
 * vendor's proof page at `/`.
 *
 * Everything else — /v1/observe, /v1/config, /proofs/*, /attest/*,
 * /.well-known/*, /api/cron/* — is the product's public collection/proof API
 * and stays reachable with no session; this does not gate anything.
 */
export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	// A vendor's own proof domain (proof.acme.com): its root IS its proof page.
	// An unknown or unpublished host answers 404 rather than our home page, so a
	// hostname can't confirm who has installed us. See lib/vendors/custom-domain.ts.
	const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
	if (host && !isOwnHost(host)) {
		const slug = await slugForCustomDomain(host.split(":")[0]);
		if (!slug) return new NextResponse("Not found", { status: 404 });
		if (pathname === "/") {
			const target = prefersJson(request.headers.get("accept")) ? `/api/proofs/${slug}` : `/proofs/${slug}`;
			return NextResponse.rewrite(new URL(target, request.url));
		}
		// Only this vendor's own documents, and the shared pages a reader needs to
		// check them. Without this, proof.acme.com/attest/rival.json served a
		// rival's proof from Acme's domain.
		if (SENT_HOME.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
			// Letterprove's own pages, and everything a reader uses to CHECK a
			// proof, are sent home rather than served as the vendor's. The vendor
			// controls this hostname's DNS: if keys, discovery or verify pages
			// were served here, a vendor pointing it at its own server could serve
			// forged documents beside its own keys and a "verified" page for them.
			// Verification only ever happens at app.letterprove.com.
			return NextResponse.redirect(`${VERIFY_ORIGIN}${pathname}${request.nextUrl.search}`, 308);
		}
		if (!servesOnCustomDomain(pathname, slug)) return new NextResponse("Not found", { status: 404 });
	}

	const match = pathname.match(/^\/proofs\/([^/]+)$/);
	if (!match) return;

	const [, segment] = match;
	const suffixed = segment.endsWith(".json");
	const slug = suffixed ? segment.slice(0, -".json".length) : segment;

	if (suffixed || prefersJson(request.headers.get("accept"))) {
		return NextResponse.rewrite(new URL(`/api/proofs/${slug}`, request.url));
	}
}

/**
 * What a custom domain redirects to app.letterprove.com: Letterprove's own
 * pages, and the whole verification surface (keys, discovery, verify pages).
 */
const SENT_HOME = ["/docs", "/privacy", "/terms", "/keys", "/verify", "/.well-known", "/api/well-known"];

/**
 * What a vendor's custom domain may serve besides its root: its own proof page,
 * attestations and chains, plus the framework assets those pages load. Keys,
 * discovery and verify pages are never served here (see SENT_HOME).
 */
function servesOnCustomDomain(pathname: string, slug: string): boolean {
	const own = [`/proofs/${slug}`, `/attest/${slug}`, `/api/proofs/${slug}`];
	if (own.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}.`))) return true;
	return (
		pathname.startsWith("/_next/") ||
		["/favicon.ico", "/icon.png", "/apple-icon.png", "/logo.svg", "/robots.txt"].includes(pathname)
	);
}

/**
 * Browsers send `text/html,...,*\/*`, so a bare wildcard must NOT count as
 * asking for JSON — that would serve raw documents to people. Only an explicit
 * JSON preference with no HTML alternative counts.
 */
function prefersJson(accept: string | null): boolean {
	if (!accept) return false;
	const lower = accept.toLowerCase();
	return lower.includes("application/json") && !lower.includes("text/html");
}

// Every path, so a custom domain can be held to its own vendor's pages. On our
// own hosts everything but /proofs returns immediately, without a lookup.
export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
