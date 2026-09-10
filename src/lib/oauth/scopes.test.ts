// Two halves, and they are no longer the same kind of test.
//
// `capabilityValues` is live: it is the vocabulary `dispatchTool` gates on, so
// the registry-coverage test at the bottom guards a real invariant.
//
// Everything above it covers the scope-STRING helpers, which lost their caller
// when the OAuth server was retired (#124, #130). They are kept as a record of
// what the wildcard was for: a client row whose allowed_scopes were enumerated
// at seed time silently withholds every capability added afterwards, and
// because the list was read at /authorize, a CLI that logged in before the
// addition stayed frozen at the old vocabulary until it re-logged in — which
// nobody knows to do. If those helpers are ever deleted, delete these with
// them; they are not evidence that anything ships.

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
	it("describes every known scope in words a grant prompt could show", () => {
		for (const scope of KNOWN_SCOPES) {
			expect(scopeDescription(scope)).not.toBe(scope);
		}
	});

	it("falls back to the raw scope rather than rendering undefined", () => {
		expect(scopeDescription("vendor:teleport")).toBe("vendor:teleport");
	});
});

describe("capabilityValues against the tool registry", () => {
	// The vocabulary and the registry are edited in different files, and a
	// mismatch is silent in both directions. A tool declaring a capability
	// outside this list can never be dispatched, because `dispatchTool` only
	// ever sees capabilities minted from it. A capability no tool declares is
	// the opposite failure, and the one this repo has actually had: after the
	// OAuth server was retired, `staff:read`/`staff:write` were still in the
	// vocabulary with no caller in the world able to reach the two tools that
	// wanted them (#126 gave them one back).

	it("holds exactly the capabilities the tools declare", async () => {
		const { TOOLS } = await import("@/lib/tools/registry");
		const declared = new Set(TOOLS.map((tool) => tool.capability));

		expect([...declared].sort()).toEqual([...capabilityValues].sort());
	});
});
