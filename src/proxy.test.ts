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

/**
 * The vendor gate asks two questions, not one: is there a user, and does that
 * user belong to a vendor. `membership` is the answer to the second — null
 * means signed in but membership-less, which is the state a fresh signup is
 * in and the reason /vendor/onboarding exists.
 */
function mockSupabaseVendor(
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

describe("proxy — /vendor auth gate", () => {
	const USER = { id: "u1", email: "vendor@acme.com" };

	it("503s rather than falling open when auth isn't configured", async () => {
		// An account area has no safe "unauthenticated but allowed" default.
		setAuthEnv(false);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor"));

		expect(res?.status).toBe(503);
		expect(await res?.json()).toEqual({
			error: "Vendor auth is not configured on this deployment",
		});
	});

	it("sends a signed-out visitor to the login page, remembering where they were going", async () => {
		setAuthEnv(true);
		mockSupabaseVendor(null, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/customers"));

		expect(res?.status).toBe(307);
		const location = new URL(res!.headers.get("location")!);
		expect(location.pathname).toBe("/vendor/login");
		expect(location.searchParams.get("redirect")).toBe("/vendor/customers");
	});

	it("lets the login page itself through, or it could never be reached", async () => {
		setAuthEnv(true);
		mockSupabaseVendor(null, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/login"));

		expect(res?.status).not.toBe(307);
	});

	it("sends a signed-in user with no vendor to onboarding", async () => {
		// The state every fresh signup lands in: a session, no membership row.
		setAuthEnv(true);
		mockSupabaseVendor(USER, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor"));

		expect(res?.status).toBe(307);
		expect(new URL(res!.headers.get("location")!).pathname).toBe("/vendor/onboarding");
	});

	it("lets a membership-less user reach onboarding — it is the page that creates the membership", async () => {
		// Gating onboarding on having a membership would make it unreachable,
		// which would strand every new signup permanently.
		setAuthEnv(true);
		mockSupabaseVendor(USER, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/onboarding"));

		expect(res?.status).not.toBe(307);
	});

	it("lets a member through to the dashboard", async () => {
		setAuthEnv(true);
		mockSupabaseVendor(USER, { vendor_id: "v1" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor"));

		expect(res?.status).not.toBe(307);
	});

	it("does not bounce a signed-in member back to onboarding once they have one", async () => {
		// Regression guard: an over-eager membership check here would put a
		// working vendor into a redirect loop between /vendor and onboarding.
		setAuthEnv(true);
		mockSupabaseVendor(USER, { vendor_id: "v1" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/proof"));

		expect(res?.status).not.toBe(307);
	});


	it("sends a signed-in visitor away from the sign-in page", async () => {
		// The layout renders the full vendor shell for a signed-in user, so
		// /vendor/login showed working Dashboard/Customers/Proof tabs sitting
		// above a form asking them to log in.
		setAuthEnv(true);
		mockSupabaseVendor(USER, { vendor_id: "v1" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/login"));

		expect(res?.status).toBe(307);
		expect(new URL(res!.headers.get("location")!).pathname).toBe("/vendor");
	});

	it("sends a signed-in member away from a bare visit to onboarding", async () => {
		// Onboarding only ever creates a NEW vendor, so a member landing here
		// by accident used to end up with one nothing could reach. A stray
		// click must still bounce.
		setAuthEnv(true);
		mockSupabaseVendor(USER, { vendor_id: "v1" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/onboarding"));

		expect(res?.status).toBe(307);
		expect(new URL(res!.headers.get("location")!).pathname).toBe("/vendor");
	});

	it("lets a member through to onboarding when they meant it", async () => {
		// ?new=1 is set only by the switcher's own "Add a vendor" link. The
		// switcher is also what makes the second vendor reachable afterwards,
		// so intent and visibility arrive together.
		setAuthEnv(true);
		mockSupabaseVendor(USER, { vendor_id: "v1" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/onboarding?new=1"));

		expect(res?.status).not.toBe(307);
	});

	it("does not accept any other value as intent", async () => {
		setAuthEnv(true);
		mockSupabaseVendor(USER, { vendor_id: "v1" });
		const { proxy: p } = await freshProxy();

		for (const qs of ["?new=0", "?new=true", "?new", "?other=1"]) {
			const res = await p(new NextRequest(`https://app.letterprove.com/vendor/onboarding${qs}`));
			expect(res?.status, qs).toBe(307);
		}
	});

	it("still lets a membership-less user through to onboarding", async () => {
		// The rule above must not strand a fresh signup, who has no membership
		// and nowhere else to go.
		setAuthEnv(true);
		mockSupabaseVendor(USER, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/onboarding"));

		expect(res?.status).not.toBe(307);
	});

	it("keeps the password-recovery page reachable without a membership", async () => {
		// A recovery link signs the user in before onboarding may have
		// happened; bouncing them to onboarding would lose the reset.
		setAuthEnv(true);
		mockSupabaseVendor(USER, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/reset-password"));

		expect(res?.status).not.toBe(307);
	});

	it("does not bounce a signed-out visitor off the sign-in page", async () => {
		// The redirect above is for signed-in visitors only — applying it to
		// everyone would make signing in impossible.
		setAuthEnv(true);
		mockSupabaseVendor(null, null);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/vendor/login"));

		expect(res?.status).not.toBe(307);
	});

	it("leaves the public collection and proof surface ungated", async () => {
		// /vendor is a login wall; the product's public API must not be behind
		// it. These carry no session and must stay reachable.
		setAuthEnv(true);
		mockSupabaseVendor(null, null);
		const { proxy: p } = await freshProxy();

		for (const path of ["/v1/observe", "/v1/config", "/.well-known/jwks.json", "/api/cron/rollup"]) {
			const res = await p(new NextRequest(`https://app.letterprove.com${path}`));
			expect(res, path).toBeUndefined();
		}
	});
});

// Re-imports proxy.ts per test so module-level mocks of @supabase/ssr apply
// cleanly — the auth gate itself reads env at call time (not module load), so
// no reset is needed for that half, but vi.doMock only affects new imports.
async function freshProxy() {
	vi.resetModules();
	return import("./proxy");
}
