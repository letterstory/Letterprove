import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/vendors/session", () => ({ currentVendor: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/vendors/customers", () => ({ generateConsentLink: vi.fn(), clearConsentToken: vi.fn() }));
vi.mock("@/lib/email/consent", () => ({ sendConsentRequest: vi.fn() }));

import { currentVendor } from "@/lib/vendors/session";
import { createServerSupabaseClient } from "@/lib/auth/server";
import { clearConsentToken, generateConsentLink } from "@/lib/vendors/customers";
import { sendConsentRequest } from "@/lib/email/consent";

const PARAMS = { params: Promise.resolve({ slug: "widgets" }) };
const FAKE_SUPABASE = { fake: "client" };
const VENDOR = { id: "v1", slug: "acme", name: "Acme Inc" };

function req(body: unknown = { contactEmail: "ops@widgets.com" }) {
	return new Request("https://app.letterprove.com/api/vendor/customers/widgets/consent-link", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function minted(over: Record<string, unknown> = {}) {
	return {
		ok: true as const,
		data: {
			token: "tok123",
			expiresAt: "2026-08-28T06:00:00.000Z",
			sentTo: "ops@widgets.com",
			customerName: "Widgets Ltd",
			...over,
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(createServerSupabaseClient).mockResolvedValue(FAKE_SUPABASE as never);
	vi.mocked(sendConsentRequest).mockResolvedValue({ ok: true });
});

describe("POST /api/vendor/customers/[slug]/consent-link", () => {
	it("rejects an unauthenticated caller before touching the database", async () => {
		vi.mocked(currentVendor).mockResolvedValue(null);

		const res = await POST(req(), PARAMS);

		expect(res.status).toBe(401);
		expect(generateConsentLink).not.toHaveBeenCalled();
	});

	it("emails the link and answers with the recipient, never the token or a URL", async () => {
		vi.mocked(currentVendor).mockResolvedValue(VENDOR as never);
		vi.mocked(generateConsentLink).mockResolvedValue(minted());

		const res = await POST(req(), PARAMS);
		const body = await res.json();

		expect(generateConsentLink).toHaveBeenCalledWith(FAKE_SUPABASE, "v1", "widgets", "ops@widgets.com");
		expect(sendConsentRequest).toHaveBeenCalledWith({
			to: "ops@widgets.com",
			vendorName: "Acme Inc",
			customerName: "Widgets Ltd",
			url: "https://app.letterprove.com/attest/acme/widgets/consent?token=tok123",
			expiresAt: "2026-08-28T06:00:00.000Z",
		});

		expect(body).toEqual({ sentTo: "ops@widgets.com", expiresAt: "2026-08-28T06:00:00.000Z" });

		/*
		 * The whole point of the redesign, asserted directly rather than left to
		 * the shape check above: if the vendor can read the token they can open
		 * the consent page themselves and countersign on their customer's
		 * behalf, and earned() promotes that to tier 4 ahead of the
		 * domain-verified and observed gates. A response that leaks the token
		 * restores the exact hole this endpoint exists to close.
		 */
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("tok123");
		expect(serialized).not.toContain("/consent");
	});

	it("passes through a not_found from the service layer for a customer that doesn't belong to this vendor", async () => {
		vi.mocked(currentVendor).mockResolvedValue(VENDOR as never);
		vi.mocked(generateConsentLink).mockResolvedValue({ ok: false, status: 404, body: { error: "not_found" } });

		const res = await POST(req(), PARAMS);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not_found" });
		expect(sendConsentRequest).not.toHaveBeenCalled();
	});

	it("passes through the 422 when the address isn't on the customer's domain", async () => {
		vi.mocked(currentVendor).mockResolvedValue(VENDOR as never);
		vi.mocked(generateConsentLink).mockResolvedValue({
			ok: false,
			status: 422,
			body: { error: "The consent link can only be sent to an address at widgets.com." },
		});

		const res = await POST(req({ contactEmail: "me@acme.com" }), PARAMS);

		expect(res.status).toBe(422);
		expect(sendConsentRequest).not.toHaveBeenCalled();
	});

	it("rolls the token back when the email fails, so no unreachable link is left live", async () => {
		vi.mocked(currentVendor).mockResolvedValue(VENDOR as never);
		vi.mocked(generateConsentLink).mockResolvedValue(minted());
		vi.mocked(sendConsentRequest).mockResolvedValue({ ok: false, error: "Couldn't send the consent email." });

		const res = await POST(req(), PARAMS);

		expect(res.status).toBe(502);
		// Scoped to the exact token, so a link minted in between isn't wiped.
		expect(clearConsentToken).toHaveBeenCalledWith(FAKE_SUPABASE, "v1", "widgets", "tok123");
	});

	it("builds the link against the request's own origin, not a hardcoded host", async () => {
		vi.mocked(currentVendor).mockResolvedValue(VENDOR as never);
		vi.mocked(generateConsentLink).mockResolvedValue(minted());

		const local = new Request("http://localhost:9100/api/vendor/customers/widgets/consent-link", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ contactEmail: "ops@widgets.com" }),
		});
		await POST(local, PARAMS);

		expect(vi.mocked(sendConsentRequest).mock.calls[0][0].url).toBe(
			"http://localhost:9100/attest/acme/widgets/consent?token=tok123",
		);
	});

	it("survives a request with no JSON body instead of throwing", async () => {
		vi.mocked(currentVendor).mockResolvedValue(VENDOR as never);
		vi.mocked(generateConsentLink).mockResolvedValue({
			ok: false,
			status: 422,
			body: { error: "A contact email at the customer is required." },
		});

		const res = await POST(
			new Request("https://app.letterprove.com/api/vendor/customers/widgets/consent-link", { method: "POST" }),
			PARAMS,
		);

		expect(res.status).toBe(422);
		expect(generateConsentLink).toHaveBeenCalledWith(FAKE_SUPABASE, "v1", "widgets", undefined);
	});
});
