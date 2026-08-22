import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/auth/server", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/vendors/session", () => ({ currentVendor: vi.fn() }));
vi.mock("@/lib/support/slack", () => ({ sendSupportMessage: vi.fn() }));

function req(body: unknown) {
	return new NextRequest("https://app.letterprove.com/api/vendor/support", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

const vendor = { id: "v1", slug: "acme", name: "Acme", domain: "acme.com", category: "cdp", key: "k" };
const user = { id: "u1", email: "a@acme.com" };

beforeEach(() => vi.clearAllMocks());

describe("POST /api/vendor/support", () => {
	it("sends the message with the caller's vendor and email context", async () => {
		const { getUser } = await import("@/lib/auth/server");
		const { currentVendor } = await import("@/lib/vendors/session");
		const { sendSupportMessage } = await import("@/lib/support/slack");
		vi.mocked(getUser).mockResolvedValue(user as never);
		vi.mocked(currentVendor).mockResolvedValue(vendor as never);
		vi.mocked(sendSupportMessage).mockResolvedValue({ ok: true });

		const res = await POST(req({ message: "help please" }));

		expect(res.status).toBe(200);
		expect(sendSupportMessage).toHaveBeenCalledWith({
			vendorName: "Acme",
			vendorSlug: "acme",
			userEmail: "a@acme.com",
			message: "help please",
		});
	});

	it("refuses when nobody is signed in", async () => {
		const { getUser } = await import("@/lib/auth/server");
		const { sendSupportMessage } = await import("@/lib/support/slack");
		vi.mocked(getUser).mockResolvedValue(null as never);

		const res = await POST(req({ message: "help please" }));

		expect(res.status).toBe(401);
		expect(sendSupportMessage).not.toHaveBeenCalled();
	});

	it("400s when the caller has no vendor", async () => {
		const { getUser } = await import("@/lib/auth/server");
		const { currentVendor } = await import("@/lib/vendors/session");
		vi.mocked(getUser).mockResolvedValue(user as never);
		vi.mocked(currentVendor).mockResolvedValue(null);

		const res = await POST(req({ message: "help please" }));

		expect(res.status).toBe(400);
	});

	it("requires a non-empty message, without calling Slack", async () => {
		const { getUser } = await import("@/lib/auth/server");
		const { currentVendor } = await import("@/lib/vendors/session");
		const { sendSupportMessage } = await import("@/lib/support/slack");
		vi.mocked(getUser).mockResolvedValue(user as never);
		vi.mocked(currentVendor).mockResolvedValue(vendor as never);

		for (const body of [{}, { message: "" }, { message: "   " }, { message: 42 }]) {
			const res = await POST(req(body));
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
		expect(sendSupportMessage).not.toHaveBeenCalled();
	});

	it("rejects a message over the length limit", async () => {
		const { getUser } = await import("@/lib/auth/server");
		const { currentVendor } = await import("@/lib/vendors/session");
		vi.mocked(getUser).mockResolvedValue(user as never);
		vi.mocked(currentVendor).mockResolvedValue(vendor as never);

		const res = await POST(req({ message: "x".repeat(4001) }));

		expect(res.status).toBe(400);
	});

	it("surfaces a delivery failure instead of reporting success", async () => {
		const { getUser } = await import("@/lib/auth/server");
		const { currentVendor } = await import("@/lib/vendors/session");
		const { sendSupportMessage } = await import("@/lib/support/slack");
		vi.mocked(getUser).mockResolvedValue(user as never);
		vi.mocked(currentVendor).mockResolvedValue(vendor as never);
		vi.mocked(sendSupportMessage).mockResolvedValue({ ok: false, error: "boom" });

		const res = await POST(req({ message: "help please" }));

		expect(res.status).toBe(502);
	});
});
