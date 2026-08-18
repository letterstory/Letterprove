// The wildcard is the one piece of this OAuth port that is deliberately NOT a
// straight copy of the sister product, so it gets its own test. The bug being
// prevented: a client row whose allowed_scopes were enumerated at seed time
// silently withholds every capability added afterwards, and because the list is
// read at /authorize, a CLI that logged in before the addition stays frozen at
// the old vocabulary until it re-logs in — which nobody knows to do.

import { describe, expect, it } from "vitest";
import {
	ALL_SCOPES_WILDCARD,
	KNOWN_SCOPES,
	OFFLINE_ACCESS,
	capabilitiesFromScope,
	capabilityValues,
	expandScopeWildcard,
	formatScope,
	parseScope,
	resolveGrantableScope,
	scopeDescription,
} from "./scopes";

describe("expandScopeWildcard", () => {
	it("expands the sentinel to every scope this server currently knows", () => {
		expect(expandScopeWildcard([ALL_SCOPES_WILDCARD]).sort()).toEqual([...KNOWN_SCOPES].sort());
	});

	it("includes offline_access, so a wildcard client always gets a refresh token", () => {
		// Without this, `letterprove login` would come back with an access token
		// only and the CLI would demand a browser round trip every hour.
		expect(expandScopeWildcard([ALL_SCOPES_WILDCARD])).toContain(OFFLINE_ACCESS);
	});

	it("tracks capabilityValues rather than a snapshot of it", () => {
		// The real assertion: expansion is derived, so adding to capabilityValues
		// is sufficient and no migration is needed to widen an existing client.
		for (const capability of capabilityValues) {
			expect(expandScopeWildcard([ALL_SCOPES_WILDCARD])).toContain(capability);
		}
	});

	it("leaves a curated list alone", () => {
		expect(expandScopeWildcard(["vendor:read"])).toEqual(["vendor:read"]);
	});

	it("does not treat the sentinel as a grantable scope itself", () => {
		// A client holding '*' must never end up with a literal '*' in an issued
		// token's scope — downstream capability checks would not recognize it.
		const granted = resolveGrantableScope(
			[ALL_SCOPES_WILDCARD, "vendor:read"],
			expandScopeWildcard([ALL_SCOPES_WILDCARD]),
		);
		expect(granted).toEqual(["vendor:read"]);
	});
});

describe("resolveGrantableScope", () => {
	it("intersects the request with what the client is registered for", () => {
		expect(resolveGrantableScope(["vendor:read", "vendor:write"], ["vendor:read"])).toEqual(["vendor:read"]);
	});

	it("drops unknown scopes instead of failing the whole request", () => {
		// A newer CLI asking a not-yet-deployed server for a capability it does
		// not have is a version skew, not an attack — grant what can be supported.
		expect(resolveGrantableScope(["vendor:read", "vendor:teleport"], ["*", "vendor:read"])).toEqual(["vendor:read"]);
	});

	it("grants nothing when the client is registered for nothing", () => {
		expect(resolveGrantableScope(["vendor:read"], [])).toEqual([]);
	});
});

describe("parseScope / formatScope", () => {
	it("round-trips a space-delimited scope string", () => {
		expect(parseScope("vendor:read vendor:write")).toEqual(["vendor:read", "vendor:write"]);
	});

	it("tolerates the whitespace a hand-built authorize URL actually contains", () => {
		expect(parseScope("  vendor:read\t\nvendor:write ")).toEqual(["vendor:read", "vendor:write"]);
	});

	it("deduplicates and sorts so the stored scope is canonical", () => {
		expect(formatScope(["vendor:write", "vendor:read", "vendor:write"])).toBe("vendor:read vendor:write");
	});
});

describe("capabilitiesFromScope", () => {
	it("keeps capabilities and drops the OAuth-only scope", () => {
		expect(capabilitiesFromScope([OFFLINE_ACCESS, "vendor:read"])).toEqual(["vendor:read"]);
	});
});

describe("scopeDescription", () => {
	it("describes every known scope in words a consent screen can show", () => {
		for (const scope of KNOWN_SCOPES) {
			expect(scopeDescription(scope)).not.toBe(scope);
		}
	});

	it("falls back to the raw scope rather than rendering undefined", () => {
		expect(scopeDescription("vendor:teleport")).toBe("vendor:teleport");
	});
});
