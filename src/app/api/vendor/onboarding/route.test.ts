import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient: vi.fn() }));

/**
 * Onboarding is the only place a vendor's `domain` is set for the first time,
 * and that value is compared for equality against every incoming Origin
 * header. Get it wrong and the vendor collects nothing, forever, with no
 * error anywhere — /v1/observe is sendBeacon-safe and answers 204 either way.
 * So these tests are mostly about what the route REFUSES to store.
 */

function mockSupabase() {
	const insert = vi.fn().mockResolvedValue({ error: null });
	const from = vi.fn().mockReturnValue({ insert });
	const getUser = vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } });
	return { from, insert, auth: { getUser } };
}

function req(body: unknown) {
	return new Request("https://app.letterprove.com/api/vendor/onboarding", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

let db: ReturnType<typeof mockSupabase>;

beforeEach(async () => {
	vi.clearAllMocks();
	const { createServerSupabaseClient } = await import("@/lib/auth/server");
	db = mockSupabase();
	vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
});

describe("POST /api/vendor/onboarding", () => {
	it("stores the bare hostname when given a full URL", async () => {
		// The exact input that was live in production and collected nothing.
		const res = await POST(req({ name: "Steve Johnson dev", domain: "https://steve-johnson.dev/", category: "dev" }));
		expect(res.status).toBe(303);

		const vendorInsert = db.insert.mock.calls
			.map((c) => c[0] as Record<string, unknown>)
			.find((row) => "domain" in row);
		expect(vendorInsert?.domain).toBe("steve-johnson.dev");
	});

	it("lowercases and strips a port", async () => {
		await POST(req({ name: "Acme", domain: "ACME.com:3000", category: "cdp" }));
		const vendorInsert = db.insert.mock.calls
			.map((c) => c[0] as Record<string, unknown>)
			.find((row) => "domain" in row);
		expect(vendorInsert?.domain).toBe("acme.com");
	});

	it("rejects a domain that could never match an Origin, without touching the db", async () => {
		const res = await POST(req({ name: "Acme", domain: "my company", category: "cdp" }));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: expect.stringContaining("hostname") });
		// Nothing half-created: no vendor row, no membership row.
		expect(db.insert).not.toHaveBeenCalled();
	});

	it("still requires all three fields", async () => {
		const res = await POST(req({ name: "Acme", domain: "", category: "cdp" }));
		expect(res.status).toBe(400);
		expect(db.insert).not.toHaveBeenCalled();
	});

	it("refuses when nobody is signed in", async () => {
		db.auth.getUser.mockResolvedValue({ data: { user: null } });
		const res = await POST(req({ name: "Acme", domain: "acme.com", category: "cdp" }));
		expect(res.status).toBe(401);
		expect(db.insert).not.toHaveBeenCalled();
	});

	it("creates the membership row too, or the vendor is unclaimable", async () => {
		// A vendor row with no vendor_members row can never be reached by
		// anyone — RLS scopes every read through membership.
		await POST(req({ name: "Acme", domain: "acme.com", category: "cdp" }));
		const tables = db.from.mock.calls.map((c) => c[0]);
		expect(tables).toContain("vendors");
		expect(tables).toContain("vendor_members");
	});
});
