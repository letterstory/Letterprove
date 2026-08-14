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

	it("passes an authenticated request through to /staff", async () => {
		setAuthEnv(true);
		mockSupabaseUser({ id: "u1", email: "staff@letterbrace.com" });
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/staff"));

		expect(res?.status).not.toBe(307);
		expect(res?.status).not.toBe(503);
	});

	it("never touches the public collection/proof API", async () => {
		setAuthEnv(false);
		const { proxy: p } = await freshProxy();

		const res = await p(new NextRequest("https://app.letterprove.com/api/v1/observe"));

		expect(res).toBeUndefined();
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
