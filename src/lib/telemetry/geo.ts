/**
 * Approximate origin of a request, read from the edge.
 *
 * This is the ONLY place the codebase reads a location header, deliberately.
 * /privacy §2 makes a specific promise — country and first-level region, never
 * city, coordinates, or postal code — and a promise like that is only keepable
 * if there is one file to check it against. Widening what this returns means
 * changing a published policy first.
 *
 * Vercel offers x-vercel-ip-city, -latitude, -longitude and -postal-code on
 * the same request. They are not read here and should not be added: a region
 * holds millions of people and identifies none of them, while the extra
 * precision buys nothing against a spoofer who can pick their exit node.
 */

/** ISO 3166-1 alpha-2, e.g. "US". */
const COUNTRY_HEADER = "x-vercel-ip-country";
/** The region part of ISO 3166-2, e.g. "CA" for California. */
const REGION_HEADER = "x-vercel-ip-country-region";

export interface RequestGeo {
	country: string | null;
	region: string | null;
}

/**
 * Absent headers are normal, not exceptional: the edge omits them when it
 * cannot place an address, and local development has no edge in front of it at
 * all. Null is a steady state, so nothing downstream may treat it as an error.
 *
 * Values are bounded and uppercased rather than trusted as-is. These arrive as
 * headers, and a header is attacker-controlled input even when it is usually
 * written by our own infrastructure — an unbounded string would otherwise flow
 * straight into a column and out into a feature stream.
 */
export function requestGeo(headers: Headers): RequestGeo {
	return {
		country: normalize(headers.get(COUNTRY_HEADER), 2),
		region: normalize(headers.get(REGION_HEADER), 3),
	};
}

function normalize(raw: string | null, maxLength: number): string | null {
	if (!raw) return null;
	const trimmed = raw.trim().toUpperCase();
	if (trimmed.length === 0 || trimmed.length > maxLength) return null;
	// Letters and digits only. ISO codes are alphanumeric, and refusing
	// anything else keeps a malformed header out of the data rather than
	// storing it and hoping every later reader escapes it.
	return /^[A-Z0-9]+$/.test(trimmed) ? trimmed : null;
}
