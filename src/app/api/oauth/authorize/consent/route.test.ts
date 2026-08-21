import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// Consent no longer narrows the grant by membership or the staff allowlist —
// dispatchTool (registry.ts) re-checks both, fresh, on every call instead. So
// this file's job shrank to: grant whatever was requested, and still make the
// caller pick a vendor when vendor:* is in play (routing, not permission —
// dispatchTool is what decides whether that vendor_id is actually theirs) —
// except when there's nothing to pick from, where vendor:* is dropped rather
// than blocking the login entirely.
// See project_letterprove-cli-controllable, 2026-08-19.

vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/oauth/core", () => ({
	getPendingRequest: vi.fn(),
	consumePendingForConsent: vi.fn(),
	denyPendingRequest: vi.fn(),
	upsertAuthorization: vi.fn(),
	issueAuthorizationCode: vi.fn(),
}));
vi.mock("@/lib/oauth/ratelimit", () => ({ oauthRateLimit: vi.fn(), oauthClientIp: vi.fn(() => "1.2.3.4") }));
vi.mock("@/lib/vendors/session", () => ({ vendorMemberships: vi.fn() }));

import { createServerSupabaseClient } from "@/lib/auth/server";
import {
	getPendingRequest,
	consumePendingForConsent,
	upsertAuthorization,
	issueAuthorizationCode,
} from "@/lib/oauth/core";
import { oauthRateLimit } from "@/lib/oauth/ratelimit";
import { vendorMemberships } from "@/lib/vendors/session";

const USER = { id: "user-1", email: "staff@letterprove.com" };

const PENDING = {
	id: "p1",
	nonce: "nonce-1",
	client_id: "cli",
	vendor_id: null,
	user_id: "user-1",
	redirect_uri: "http://127.0.0.1:9999/callback",
	scope: "vendor:read vendor:write staff:read staff:write offline_access",
	state: "st",
	code_challenge: "chal",
	code_challenge_method: "S256",
	status: "claimed",
	expires_at: new Date(Date.now() + 60_000).toISOString(),
};

function form(fields: Record<string, string>) {
	const body = new URLSearchParams(fields);
	// NextRequest, not Request: POST's signature demands the Next type, and a
	// plain Request only satisfied it by accident of structural typing until the
	// typechecker was actually run against this file.
	return POST(
		new NextRequest("https://app.letterprove.com/api/oauth/authorize/consent", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(oauthRateLimit).mockResolvedValue(true);
	vi.mocked(createServerSupabaseClient).mockResolvedValue({
		auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER } }) },
	} as never);
	vi.mocked(getPendingRequest).mockResolvedValue(PENDING as never);
	vi.mocked(consumePendingForConsent).mockResolvedValue(PENDING as never);
	vi.mocked(upsertAuthorization).mockResolvedValue({ id: "auth-1" } as never);
	vi.mocked(issueAuthorizationCode).mockResolvedValue("code-1");
	vi.mocked(vendorMemberships).mockResolvedValue([
		{ id: "v1", name: "Acme", slug: "acme", domain: "acme.com" },
	]);
});

describe("POST /api/oauth/authorize/consent — grants whatever was requested", () => {
	it("grants every requested scope, staff included, without checking membership or the allowlist", async () => {
		const res = await form({ nonce: "nonce-1", decision: "allow", vendor_id: "v1" });

		expect(res.status).toBe(307);
		const grantedScope = vi.mocked(upsertAuthorization).mock.calls[0]![0].scope;
		expect(grantedScope).toContain("vendor:read");
		expect(grantedScope).toContain("vendor:write");
		expect(grantedScope).toContain("staff:read");
		expect(grantedScope).toContain("staff:write");
	});

	it("requires a vendor_id when vendor scope is requested, but does not verify it against membership", async () => {
		const res = await form({ nonce: "nonce-1", decision: "allow", vendor_id: "not-my-vendor" });

		expect(res.status).toBe(307);
		expect(consumePendingForConsent).toHaveBeenCalledWith("nonce-1", "user-1", "not-my-vendor");
		expect(upsertAuthorization).toHaveBeenCalledWith(expect.objectContaining({ vendorId: "not-my-vendor" }));
	});

	it("refuses rather than grants when vendor scope is requested but no vendor_id was submitted", async () => {
		const res = await form({ nonce: "nonce-1", decision: "allow" });

		expect(res.status).toBe(400);
		expect(consumePendingForConsent).not.toHaveBeenCalled();
		expect(upsertAuthorization).not.toHaveBeenCalled();
	});

	it("grants a staff-only, vendor-less request with no vendor_id needed", async () => {
		vi.mocked(getPendingRequest).mockResolvedValue({ ...PENDING, scope: "staff:read staff:write" } as never);

		const res = await form({ nonce: "nonce-1", decision: "allow" });

		expect(res.status).toBe(307);
		expect(consumePendingForConsent).toHaveBeenCalledWith("nonce-1", "user-1", null);
		const grantedScope = vi.mocked(upsertAuthorization).mock.calls[0]![0].scope;
		expect(grantedScope).toContain("staff:read");
		expect(grantedScope).toContain("staff:write");
	});

	it("drops vendor:* rather than blocking the login when the user has zero vendor memberships", async () => {
		vi.mocked(vendorMemberships).mockResolvedValue([]);

		const res = await form({ nonce: "nonce-1", decision: "allow" });

		expect(res.status).toBe(307);
		expect(consumePendingForConsent).toHaveBeenCalledWith("nonce-1", "user-1", null);
		const grantedScope = vi.mocked(upsertAuthorization).mock.calls[0]![0].scope;
		expect(grantedScope).not.toContain("vendor:");
		expect(grantedScope).toContain("staff:read");
		expect(grantedScope).toContain("staff:write");
	});

	it("refuses when nothing is left to grant after dropping vendor:* for a vendor-less, non-staff request", async () => {
		vi.mocked(vendorMemberships).mockResolvedValue([]);
		vi.mocked(getPendingRequest).mockResolvedValue({ ...PENDING, scope: "vendor:read vendor:write" } as never);

		const res = await form({ nonce: "nonce-1", decision: "allow" });

		expect(res.status).toBe(400);
		expect(consumePendingForConsent).not.toHaveBeenCalled();
		expect(upsertAuthorization).not.toHaveBeenCalled();
	});
});
