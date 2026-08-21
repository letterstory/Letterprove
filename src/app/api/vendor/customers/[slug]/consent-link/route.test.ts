import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/vendors/session", () => ({ currentVendor: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/vendors/customers", () => ({ generateConsentLink: vi.fn() }));

import { currentVendor } from "@/lib/vendors/session";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { generateConsentLink } from "@/lib/vendors/customers";

const PARAMS = { params: Promise.resolve({ slug: "widgets" }) };
const FAKE_SUPABASE = { fake: "client" };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(createServerSupabaseClient).mockResolvedValue(FAKE_SUPABASE as never);
});

describe("POST /api/vendor/customers/[slug]/consent-link", () => {
	it("rejects an unauthenticated caller before touching the database", async () => {
		vi.mocked(currentVendor).mockResolvedValue(null);

		const res = await POST(new Request("https://app.letterprove.com", { method: "POST" }), PARAMS);

		expect(res.status).toBe(401);
		expect(generateConsentLink).not.toHaveBeenCalled();
	});

	it("mints a link scoped to the caller's own vendor and includes the customer-facing path", async () => {
		vi.mocked(currentVendor).mockResolvedValue({ id: "v1", slug: "acme" } as never);
		vi.mocked(generateConsentLink).mockResolvedValue({
			ok: true,
			data: { token: "tok123", expiresAt: "2026-08-28T06:00:00.000Z" },
		});

		const res = await POST(new Request("https://app.letterprove.com", { method: "POST" }), PARAMS);
		const body = await res.json();

		expect(generateConsentLink).toHaveBeenCalledWith(FAKE_SUPABASE, "v1", "widgets");
		expect(body).toEqual({
			token: "tok123",
			expiresAt: "2026-08-28T06:00:00.000Z",
			path: "/attest/acme/widgets/consent?token=tok123",
		});
	});

	it("passes through a not_found from the service layer for a customer that doesn't belong to this vendor", async () => {
		vi.mocked(currentVendor).mockResolvedValue({ id: "v1", slug: "acme" } as never);
		vi.mocked(generateConsentLink).mockResolvedValue({ ok: false, status: 404, body: { error: "not_found" } });

		const res = await POST(new Request("https://app.letterprove.com", { method: "POST" }), PARAMS);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not_found" });
	});
});
