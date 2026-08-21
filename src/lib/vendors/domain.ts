/**
 * One definition of "a vendor's domain", shared by the two places that must
 * agree about it: what onboarding stores, and what the collector compares an
 * incoming `Origin` header against.
 *
 * They agree because both go through `hostnameOf` below. Before this existed
 * the collector derived a hostname from the request while onboarding stored
 * whatever the vendor typed, so `https://acme.com/` was accepted at signup and
 * then never matched `acme.com` at collection — and because /v1/observe is
 * sendBeacon-safe it answers 204 either way, so the vendor saw no error
 * anywhere and collected nothing. That is the worst shape a bug can take: a
 * silent, permanent zero that looks exactly like "no traffic yet".
 *
 * Deliberately NOT normalised away:
 *   - `www.` — `www.acme.com` and `acme.com` are different origins and the
 *     browser sends whichever one actually served the page. Stripping it would
 *     reintroduce the same silent mismatch in the opposite direction.
 *   - the port — `new URL().hostname` drops it, which is what the collector
 *     already compared against, so dropping it here keeps the two identical.
 */

/** The lowercase hostname of an origin/URL, or null if it isn't parseable. */
export function hostnameOf(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	// `Origin: null` is the opaque origin — sandboxed iframes, file://, some
	// cross-origin redirects. It is a real header value, not a hostname, and
	// must not become one: prepending a scheme below would otherwise parse it
	// into the perfectly valid host "null".
	if (trimmed.toLowerCase() === "null") return null;

	// A bare hostname isn't a URL, so give it a scheme before parsing. Anything
	// that already has one is left alone.
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

	let hostname: string;
	try {
		hostname = new URL(candidate).hostname.toLowerCase();
	} catch {
		return null;
	}

	// A fully-qualified name may end in a dot; the Origin header never does.
	if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);

	return hostname || null;
}

/**
 * Normalise a vendor-supplied domain, or null if it can't be one.
 *
 * Rejects rather than guesses: a vendor who typed something unusable should be
 * told at signup, which is the only moment they are looking at the field.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
	const hostname = hostnameOf(input);
	if (!hostname) return null;

	// Must look like a real host: either dotted, or bare `localhost` for local
	// development. This is what rejects "my company" and similar.
	const dotted = hostname.includes(".") && !hostname.startsWith(".") && !hostname.endsWith(".");
	if (!dotted && hostname !== "localhost") return null;

	// No spaces or credentials should survive URL parsing, but be explicit —
	// this value is compared for equality on every collected event.
	if (/[^a-z0-9.\-:[\]]/.test(hostname)) return null;

	return hostname;
}

/**
 * Human-readable reason a domain was rejected, for the signup form. Kept
 * beside the rule so the message can't describe a rule that no longer exists.
 */
export function domainRejectionReason(input: string | null | undefined): string {
	if (!input || !input.trim()) return "Domain is required.";
	return (
		`"${input.trim()}" isn't a hostname we can pin events to. ` +
		`Use just the host that serves your site — "acme.com" or "www.acme.com", ` +
		`not a full URL or a path.`
	);
}
