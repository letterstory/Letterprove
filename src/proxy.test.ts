import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function setAuthEnv(configured: boolean) {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	if (configured) {
		process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
		process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
	} else {
		delete process.env.NEXT_PUBLIC_SUPABASE_URL;
		delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
	}
}

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.restoreAllMocks();
	vi.doUnmock("@supabase/ssr");
});

function mockSupabaseUser(user: { id: string; email: string } | null) {
	vi.doMock("@supabase/ssr", () => ({
		createServerClient: vi.fn(() => ({
			auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
		})),
	}));
}

describe("proxy — /staff auth gate", () => {
	it("503s rather than falling open when auth isn't configured", async () => {
		setAuthEnv(false);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/staff"));

		expect(res?.status).toBe(503);
		expect(await res?.json()).toEqual({
			error: "Staff auth is not configured on this deployment",
		});
	});

	it("redirects an unauthenticated request to /staff/login with a redirect param", async () => {
		setAuthEnv(true);
		mockSupabaseUser(null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/staff"));

		expect(res?.status).toBe(307);
		const location = new URL(res!.headers.get("location")!);
		expect(location.pathname).toBe("/staff/login");
		expect(location.searchParams.get("redirect")).toBe("/staff");
	});

	it("lets /staff/login through for a signed-out request, no redirect loop", async () => {
		setAuthEnv(true);
		mockSupabaseUser(null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/staff/login"));

		expect(res?.status).not.toBe(307);
	});

	it("passes an allowlisted staff request through to /staff", async () => {
		setAuthEnv(true);
		process.env.STAFF_USER_IDS = "u1";
		mockSupabaseUser({ id: "u1", email: "staff@letterbrace.com" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/staff"));

		expect(res?.status).not.toBe(307);
		expect(res?.status).not.toBe(503);
	});

	/**
	 * The hole this gate closes. /staff/login offered self-service signup and
	 * Supabase had mailer_autoconfirm on, so ANY session was one form submission
	 * away — and a session alone used to satisfy this wall, exposing every
	 * vendor's withheld customer domains via /staff/tiers.
	 *
	 * Redirected to the login page (which is exempted above, so no loop) rather
	 * than passed through.
	 */
	it("turns away a signed-in user who is not on the staff allowlist", async () => {
		setAuthEnv(true);
		process.env.STAFF_USER_IDS = "u1";
		mockSupabaseUser({ id: "self-registered", email: "anyone@example.com" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/staff/tiers"));

		expect(res?.status).toBe(307);
		expect(res?.headers.get("location")).toContain("/staff/login");
		expect(res?.headers.get("location")).toContain("denied=1");
	});

	// Fails closed: a deployment that has not named its staff has none.
	it("turns everyone away when no staff allowlist is configured", async () => {
		setAuthEnv(true);
		delete process.env.STAFF_USER_IDS;
		mockSupabaseUser({ id: "u1", email: "staff@letterbrace.com" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/staff"));

		expect(res?.status).toBe(307);
		expect(res?.headers.get("location")).toContain("denied=1");
	});

	it("never touches the public collection/proof API", async () => {
		setAuthEnv(false);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/api/v1/observe"));

		expect(res).toBeUndefined();
	});
});

describe("proxy — /vendor auth gate", () => {
	function mockSupabaseUserAndMembership(
		user: { id: string; email: string } | null,
		membership: { vendor_id: string } | null,
	) {
		vi.doMock("@supabase/ssr", () => ({
			createServerClient: vi.fn(() => ({
				auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
				from: vi.fn(() => ({
					select: vi.fn(() => ({
						limit: vi.fn(() => ({
							maybeSingle: vi.fn().mockResolvedValue({ data: membership }),
						})),
					})),
				})),
			})),
		}));
	}

	it("redirects an unauthenticated request to /vendor/login with a redirect param", async () => {
		setAuthEnv(true);
		mockSupabaseUserAndMembership(null, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor"));

		expect(res?.status).toBe(307);
		const location = new URL(res!.headers.get("location")!);
		expect(location.pathname).toBe("/vendor/login");
		expect(location.searchParams.get("redirect")).toBe("/vendor");
	});

	it("redirects a signed-in user with no vendor_members row to onboarding", async () => {
		setAuthEnv(true);
		mockSupabaseUserAndMembership({ id: "u1", email: "vendor@example.com" }, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor"));

		expect(res?.status).toBe(307);
		expect(res?.headers.get("location")).toContain("/vendor/onboarding");
	});

	it("lets /vendor/onboarding through for a signed-in user with no membership yet", async () => {
		setAuthEnv(true);
		mockSupabaseUserAndMembership({ id: "u1", email: "vendor@example.com" }, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/onboarding"));

		expect(res?.status).not.toBe(307);
	});

	// The exemption this change adds: a password-recovery link signs the user
	// in (Supabase treats recovery as a real session) before they've
	// necessarily completed onboarding, so this page needs the same
	// membership-check exemption as onboarding — otherwise a recovering user
	// with no vendor yet would be bounced to onboarding instead of letting
	// them set their new password.
	it("lets /vendor/reset-password through for a signed-in user with no membership yet", async () => {
		setAuthEnv(true);
		mockSupabaseUserAndMembership({ id: "u1", email: "vendor@example.com" }, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/reset-password"));

		expect(res?.status).not.toBe(307);
	});

	it("still requires a session for /vendor/reset-password", async () => {
		setAuthEnv(true);
		mockSupabaseUserAndMembership(null, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/reset-password"));

		expect(res?.status).toBe(307);
		expect(res?.headers.get("location")).toContain("/vendor/login");
	});

	it("passes a signed-in vendor member through to /vendor", async () => {
		setAuthEnv(true);
		mockSupabaseUserAndMembership({ id: "u1", email: "vendor@example.com" }, { vendor_id: "v1" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor"));

		expect(res?.status).not.toBe(307);
	});
});

describe("proxy — /proofs content negotiation (unchanged)", () => {
	it("rewrites a .json suffix to the API route", async () => {
		const { proxy: p } = await freshProxy();
		const res = await p(new NextRequest("https://app.letterprove.com/proofs/vantage.json"));
		expect(new URL(res!.headers.get("x-middleware-rewrite")!).pathname).toBe(
			"/api/proofs/vantage",
		);
	});

	it("leaves a browser request (text/html accept) alone", async () => {
		const { proxy: p } = await freshProxy();
		const res = await p(
			new NextRequest("https://app.letterprove.com/proofs/vantage", {
				headers: { accept: "text/html,application/xhtml+xml,*/*" },
			}),
		);
		expect(res).toBeUndefined();
	});
});

// Re-imports proxy.ts per test so module-level mocks of @supabase/ssr apply
// cleanly — the auth gate itself reads env at call time (not module load), so
// no reset is needed for that half, but vi.doMock only affects new imports.
async function freshProxy() {
	vi.resetModules();
	return import("./proxy");
}
