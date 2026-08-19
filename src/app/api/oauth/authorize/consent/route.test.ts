import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// The gap this closes: the CLI's default login requests every scope its
// client is registered for (see /api/oauth/authorize), which today always
// includes vendor:* — so a staff-only user (zero vendor memberships) hits
// this exact branch on an ordinary `letterprove login`, not just a
// hand-crafted request. Getting the narrowing wrong here either blocks every
// staff login, or — worse — lets a tampered vendor_id field grant access to a
// vendor the caller doesn't belong to.

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

function eqVendorMembership(matches: boolean) {
	return {
		select: vi.fn().mockReturnValue({
			eq: vi.fn().mockReturnValue({
				maybeSingle: vi.fn().mockResolvedValue({ data: matches ? { vendor_id: "v1" } : null }),
			}),
		}),
	};
}

function form(fields: Record<string, string>) {
	const body = new URLSearchParams(fields);
	return POST(
		new Request("https://app.letterprove.com/api/oauth/authorize/consent", {
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
		from: vi.fn(),
	} as never);
	vi.mocked(getPendingRequest).mockResolvedValue(PENDING as never);
	vi.mocked(consumePendingForConsent).mockResolvedValue(PENDING as never);
	vi.mocked(upsertAuthorization).mockResolvedValue({ id: "auth-1" } as never);
	vi.mocked(issueAuthorizationCode).mockResolvedValue("code-1");
});

describe("POST /api/oauth/authorize/consent — staff vs. vendor scope narrowing", () => {
	it("grants a vendor-less user only the staff scopes, dropping vendor:* silently rather than erroring", async () => {
		vi.mocked(vendorMemberships).mockResolvedValue([]);

		const res = await form({ nonce: "nonce-1", decision: "allow" });

		expect(res.status).toBe(307);
		expect(consumePendingForConsent).toHaveBeenCalledWith("nonce-1", "user-1", null);
		expect(upsertAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({ vendorId: null, scope: expect.stringContaining("staff:read") }),
		);
		const grantedScope = vi.mocked(upsertAuthorization).mock.calls[0]![0].scope;
		expect(grantedScope).not.toContain("vendor:read");
		expect(grantedScope).not.toContain("vendor:write");
	});

	it("refuses rather than grants when a vendor-less user's request has nothing left after narrowing", async () => {
		vi.mocked(vendorMemberships).mockResolvedValue([]);
		vi.mocked(getPendingRequest).mockResolvedValue({ ...PENDING, scope: "vendor:read vendor:write" } as never);

		const res = await form({ nonce: "nonce-1", decision: "allow" });

		expect(res.status).toBe(400);
		expect(consumePendingForConsent).not.toHaveBeenCalled();
	});

	it("verifies a submitted vendor_id against real membership before granting vendor scope", async () => {
		const from = vi.fn().mockReturnValue(eqVendorMembership(true));
		vi.mocked(createServerSupabaseClient).mockResolvedValue({
			auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER } }) },
			from,
		} as never);
		vi.mocked(vendorMemberships).mockResolvedValue([{ id: "v1", name: "Vantage" }]);

		const res = await form({ nonce: "nonce-1", decision: "allow", vendor_id: "v1" });

		expect(res.status).toBe(307);
		expect(consumePendingForConsent).toHaveBeenCalledWith("nonce-1", "user-1", "v1");
		expect(upsertAuthorization).toHaveBeenCalledWith(expect.objectContaining({ vendorId: "v1" }));
	});

	it("rejects a vendor_id the caller doesn't actually belong to, even though they have other memberships", async () => {
		const from = vi.fn().mockReturnValue(eqVendorMembership(false));
		vi.mocked(createServerSupabaseClient).mockResolvedValue({
			auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER } }) },
			from,
		} as never);
		vi.mocked(vendorMemberships).mockResolvedValue([{ id: "v1", name: "Vantage" }]);

		const res = await form({ nonce: "nonce-1", decision: "allow", vendor_id: "someone-elses-vendor" });

		expect(res.status).toBe(400);
		expect(consumePendingForConsent).not.toHaveBeenCalled();
		expect(upsertAuthorization).not.toHaveBeenCalled();
	});
});
