/**
 * What a CLI token is allowed to do.
 *
 * There is no tool dispatcher yet — the surface a token will eventually reach
 * (vendor config, customers, proofs) is a later step of the CLI build. So this
 * starts deliberately coarse: read vs write against the caller's own vendor.
 * The point of landing it now is that the *mechanism* below is what stays
 * fixed while this list grows.
 */
export const capabilityValues = ["vendor:read", "vendor:write", "staff:read", "staff:write"] as const;

export type Capability = (typeof capabilityValues)[number];

const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
	"vendor:read": "Read your vendor profile, customers, and proofs.",
	"vendor:write": "Change your vendor profile, customers, and consent settings.",
	"staff:read": "Read tier reports and any vendor's customer records.",
	"staff:write": "Record customers and promote domains on any vendor's behalf.",
};

// True for a capability that acts on the caller's own vendor rather than
// staff-wide — used by the consent page to decide whether a vendor selection
// step is even relevant to what's being granted.
export function isVendorScoped(capability: string): boolean {
	return capability.startsWith("vendor:");
}

// offline_access is an OAuth convention, not a capability anyone checks — it
// only controls whether the token exchange also mints a refresh token. Every
// other scope is a 1:1 alias of a capability, so the CLI never needs a second
// vocabulary to reason about grants.
export const OFFLINE_ACCESS = "offline_access" as const;

export const KNOWN_SCOPES: readonly string[] = [...capabilityValues, OFFLINE_ACCESS];

/**
 * A client's `allowed_scopes` may hold this sentinel instead of an enumerated
 * list: "every scope this server currently knows about".
 *
 * Expanding it at request time — rather than writing the list out at seed time
 * — is the whole point. An enumerated list is a snapshot, and a snapshot goes
 * stale the moment a capability is added: the sister product shipped exactly
 * that and silently withheld a new capability from every CLI login until a
 * follow-up migration fixed it. With the sentinel, adding to capabilityValues
 * above is sufficient; no migration, and no login is frozen at the vocabulary
 * that existed when its client row was written. A client without the sentinel
 * keeps its literal, curated list.
 */
export const ALL_SCOPES_WILDCARD = "*";

export function expandScopeWildcard(allowed: string[]): string[] {
	return allowed.includes(ALL_SCOPES_WILDCARD) ? [...KNOWN_SCOPES] : allowed;
}

export function scopeDescription(scope: string): string {
	if (scope === OFFLINE_ACCESS) return "Stay signed in (refresh your session without logging in again).";
	return CAPABILITY_DESCRIPTIONS[scope as Capability] ?? scope;
}

export function parseScope(raw: string): string[] {
	return raw
		.split(/\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function formatScope(scopes: string[]): string {
	return [...new Set(scopes)].sort().join(" ");
}

/**
 * Intersects the requested scope against what the client is registered for and
 * what actually exists, dropping anything unknown rather than erroring — an
 * unrecognized scope is usually a newer CLI asking for a capability this
 * deployment does not have yet, not an attack, so grant what can be supported.
 */
export function resolveGrantableScope(requested: string[], clientAllowed: string[]): string[] {
	const allowedSet = new Set(clientAllowed);
	const knownSet = new Set(KNOWN_SCOPES);
	return requested.filter((s) => allowedSet.has(s) && knownSet.has(s));
}

export function capabilitiesFromScope(scope: string[]): Capability[] {
	const known = new Set<string>(capabilityValues);
	return scope.filter((s): s is Capability => known.has(s));
}
