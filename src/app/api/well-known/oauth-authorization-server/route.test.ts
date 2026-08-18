import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { KNOWN_SCOPES } from "@/lib/oauth/scopes";

const ORIGIN = "https://app.letterprove.com";

async function metadata(origin = ORIGIN) {
	return (await GET(new Request(`${origin}/.well-known/oauth-authorization-server`))).json();
}

describe("RFC 8414 authorization-server metadata", () => {
	it("issues for the origin it is served from, so a preview deploy describes itself", async () => {
		expect((await metadata()).issuer).toBe(ORIGIN);
		expect((await metadata("http://localhost:9140")).issuer).toBe("http://localhost:9140");
	});

	it("points at the endpoints that actually exist", async () => {
		expect(await metadata()).toMatchObject({
			authorization_endpoint: `${ORIGIN}/api/oauth/authorize`,
			token_endpoint: `${ORIGIN}/api/oauth/token`,
			revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
		});
	});

	/**
	 * The rule this file lives by: advertising a capability the server rejects
	 * is worse than advertising nothing, because a client believes it and fails
	 * in a way the metadata says is impossible. Each assertion below mirrors a
	 * refusal in the route it describes.
	 */
	it("advertises only response_type=code, which is all authorize accepts", async () => {
		expect((await metadata()).response_types_supported).toEqual(["code"]);
	});

	// authorize/route.ts requires S256 explicitly. Listing `plain` would invite
	// a native client to downgrade to the method RFC 8252 exists to prevent.
	it("advertises S256 only, never plain", async () => {
		const m = await metadata();
		expect(m.code_challenge_methods_supported).toEqual(["S256"]);
		expect(m.code_challenge_methods_supported).not.toContain("plain");
	});

	it("advertises both grants the token endpoint implements", async () => {
		expect((await metadata()).grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
	});

	// The CLI is a public client authenticating by PKCE alone, so `none` must be
	// offered or a strict client will refuse to attempt the exchange.
	it("offers `none` for public clients", async () => {
		expect((await metadata()).token_endpoint_auth_methods_supported).toContain("none");
	});

	/**
	 * Derived, not transcribed. A hand-written list here would go stale the
	 * moment a capability is added — the exact failure ALL_SCOPES_WILDCARD
	 * exists to prevent on the grant side.
	 */
	it("derives scopes from the server's own vocabulary", async () => {
		expect((await metadata()).scopes_supported).toEqual([...KNOWN_SCOPES]);
	});

	it("is publicly cacheable and readable cross-origin", async () => {
		const res = await GET(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("cache-control")).toMatch(/public/);
	});
});
