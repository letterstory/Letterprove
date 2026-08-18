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
