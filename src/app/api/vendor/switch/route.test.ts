import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient: vi.fn() }));

/**
 * Switching writes to a membership row, so the question worth testing is what
 * happens when the row named isn't the caller's. RLS filters it out rather
 * than erroring, which means the update silently affects zero rows — and a
 * route that reported success there would tell a user they had switched to a
 * vendor they cannot see.
 */
function mockSupabase(updated: unknown[], error: unknown = null) {
	const select = vi.fn().mockResolvedValue({ data: updated, error });
	const eqUser = vi.fn(() => ({ select }));
	const eqVendor = vi.fn(() => ({ eq: eqUser }));
	const update = vi.fn(() => ({ eq: eqVendor }));
	const getUser = vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } });
	return { from: vi.fn(() => ({ update })), auth: { getUser }, update, eqVendor, eqUser };
}

function req(body: unknown) {
	return new NextRequest("https://app.letterprove.com/api/vendor/switch", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

let db: ReturnType<typeof mockSupabase>;

async function withDb(d: ReturnType<typeof mockSupabase>) {
	const { createServerSupabaseClient } = await import("@/lib/auth/server");
	vi.mocked(createServerSupabaseClient).mockResolvedValue(d as never);
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/vendor/switch", () => {
	it("records the switch on the caller's own membership row", async () => {
		db = mockSupabase([{ vendor_id: "v2" }]);
		await withDb(db);

		const res = await POST(req({ vendorId: "v2" }));

		expect(res.status).toBe(200);
		// Scoped by BOTH the vendor and the user — the user filter is what
		// keeps one member from moving another's selection.
		expect(db.eqVendor).toHaveBeenCalledWith("vendor_id", "v2");
		expect(db.eqUser).toHaveBeenCalledWith("user_id", "u1");
		expect(db.update).toHaveBeenCalledWith(
			expect.objectContaining({ last_selected_at: expect.any(String) }),
		);
	});

	it("404s when the update matched nothing, rather than claiming success", async () => {
		// What a vendor the caller doesn't belong to looks like: RLS filters
		// the row out, so the update is a no-op with no error.
		db = mockSupabase([]);
		await withDb(db);

		const res = await POST(req({ vendorId: "someone-elses-vendor" }));

		expect(res.status).toBe(404);
	});

	it("refuses when nobody is signed in", async () => {
		db = mockSupabase([]);
		db.auth.getUser.mockResolvedValue({ data: { user: null } });
		await withDb(db);

		const res = await POST(req({ vendorId: "v2" }));

		expect(res.status).toBe(401);
		expect(db.from).not.toHaveBeenCalled();
	});

	it("requires a vendorId, without touching the database", async () => {
		db = mockSupabase([]);
		await withDb(db);

		for (const body of [{}, { vendorId: "" }, { vendorId: 42 }]) {
			const res = await POST(req(body));
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
		expect(db.from).not.toHaveBeenCalled();
	});

	it("surfaces a write failure instead of reporting a switch that did not happen", async () => {
		db = mockSupabase([], { message: "boom" });
		await withDb(db);

		const res = await POST(req({ vendorId: "v2" }));

		expect(res.status).toBe(500);
	});
});
