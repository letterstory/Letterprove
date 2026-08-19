import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { getUser } from "@/lib/auth/server";
import { promoteDomain } from "@/lib/staff/promote";

vi.mock("@/lib/auth/server", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/staff/promote", () => ({ promoteDomain: vi.fn() }));

function post(body: unknown) {
	return POST(
		new Request("https://app.letterprove.com/api/staff/customers", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.STAFF_USER_IDS = "staff-1";
	vi.mocked(getUser).mockResolvedValue({ id: "staff-1" } as never);
});

describe("POST /api/staff/customers", () => {
	/**
	 * The gate is the whole security story: this endpoint writes, and both the
	 * request and the response disclose which domains we have observations for.
	 * 404 rather than 401 for the same reason as the other staff surfaces — an
	 * internal endpoint that confirms its own existence tells people where to
	 * push.
	 */
	it("is invisible to a signed-out caller, and writes nothing", async () => {
		vi.mocked(getUser).mockResolvedValue(null as never);
		const res = await post({ vendor: "lettertrace", domain: "juvare.com" });
		expect(res.status).toBe(404);
		expect(promoteDomain).not.toHaveBeenCalled();
	});

	it("requires both a vendor and a domain", async () => {
		expect((await post({ vendor: "lettertrace" })).status).toBe(400);
		expect((await post({ domain: "juvare.com" })).status).toBe(400);
		expect(promoteDomain).not.toHaveBeenCalled();
	});

	it("survives a body that is not JSON at all", async () => {
		const res = await POST(
			new Request("https://app.letterprove.com/api/staff/customers", { method: "POST", body: "not json" })
		);
		expect(res.status).toBe(400);
	});

	it("returns the created record", async () => {
		vi.mocked(promoteDomain).mockResolvedValue({ ok: true, slug: "juvare", name: "Juvare", domain: "juvare.com" });
		const res = await post({ vendor: "lettertrace", domain: "juvare.com" });
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ customer: { slug: "juvare", domain: "juvare.com" } });
	});

	// Each refusal maps to a status a client can act on differently: 422 means
	// "this will never work", 409 means "it already happened", 503 means "retry".
	it.each([
		["not_attributable", 422],
		["not_observed", 422],
		["already_exists", 409],
		["vendor_unreadable", 404],
		["storage_unavailable", 503],
		["write_failed", 500],
	] as const)("maps %s to %i", async (reason, status) => {
		vi.mocked(promoteDomain).mockResolvedValue({ ok: false, reason, detail: "because" });
		const res = await post({ vendor: "lettertrace", domain: "juvare.com" });
		expect(res.status).toBe(status);
		// The detail is what the operator reads — it must survive the round trip.
		expect(await res.json()).toMatchObject({ error: reason, detail: "because" });
	});
});

/**
 * The gate that did not exist until 2026-08-18. /staff/login offered
 * self-service signup, Supabase had signup open with mailer_autoconfirm on, and
 * the wall only asked whether a session existed — so anyone on the internet
 * could register and reach this endpoint, which WRITES customer records for any
 * vendor. A session is not staff.
 */
describe("staff allowlist", () => {
	it("is invisible to a signed-in user who is not staff, and writes nothing", async () => {
		process.env.STAFF_USER_IDS = "someone-else";
		vi.mocked(getUser).mockResolvedValue({ id: "self-registered" } as never);

		const res = await post({ vendor: "lettertrace", domain: "juvare.com" });
		expect(res.status).toBe(404);
		expect(promoteDomain).not.toHaveBeenCalled();
	});

	// Fails closed: an unconfigured deployment has no staff, rather than all of them.
	it("admits nobody when no allowlist is configured", async () => {
		delete process.env.STAFF_USER_IDS;
		vi.mocked(getUser).mockResolvedValue({ id: "staff-1" } as never);

		expect((await post({ vendor: "lettertrace", domain: "juvare.com" })).status).toBe(404);
		expect(promoteDomain).not.toHaveBeenCalled();
	});
});
