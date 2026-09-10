/**
 * What a caller of the tool dispatcher is allowed to do.
 *
 * This began as the grant vocabulary of Letterprove's own OAuth 2.1 server,
 * built for the `letterprove` CLI. That server is retired: #124 deleted the
 * authorize/token/consent routes and #130 dropped the `oauth_*` tables, since
 * Letterstory is now the sole identity authority and the only caller of the
 * dispatcher is its backend, proven by a shared service secret.
 *
 * What survives is the part that was never about OAuth: `Capability` and
 * `OAuthPrincipal` are how `dispatchTool` decides whether a call may run, and
 * `src/lib/oauth-auth.ts` is what hands a principal its capabilities — vendor
 * scopes for any Letterstory-service call, staff scopes only for an acting
 * human this deployment has independently named in `STAFF_USER_IDS`.
 *
 * The scope-STRING helpers below (`parseScope`, `formatScope`,
 * `expandScopeWildcard`, `resolveGrantableScope`, `scopeDescription`) have no
 * caller left outside their own test. They are kept rather than deleted
 * because a vendor CLI is plausible post-launch, but note what the retirement
 * migration says about that: a new CLI would be built on Letterstory identity,
 * not on this foundation. Treat them as history until something imports them.
 */
export const capabilityValues = ["vendor:read", "vendor:write", "staff:read", "staff:write"] as const;

export type Capability = (typeof capabilityValues)[number];

export type OAuthPrincipal = { tokenId: string; vendorId: string | null; userId: string; capabilities: Capability[]; orgId?: string | null };

const CAPABILITY_DESCRIPTIONS: Record<Capability, string> = {
	"vendor:read": "Read your vendor profile, customers, and proofs.",
	"vendor:write": "Change your vendor profile, customers, and consent settings.",
	"staff:read": "Read tier reports and any vendor's customer records.",
	"staff:write": "Record customers and promote domains on any vendor's behalf.",
};

// Both `isVendorScoped` and `isStaffScoped` lived here, and both were read by
// the OAuth consent page: it narrowed a requested scope against who the user
// actually was before minting a grant. That page is gone with the rest of the
// server, and nothing else ever called either function. They are deleted
// rather than kept, because their docblocks asserted that staff scopes are
// narrowed at consent — a claim about a screen that no longer exists, in a
// file a reader would reasonably trust. `dispatchTool` re-checks
// `isStaffUser` on every call, which is where that narrowing really happens
// and always did.

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
