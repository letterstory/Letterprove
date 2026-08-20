import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/oauth-auth", () => ({ authenticateOAuthRequest: vi.fn() }));
vi.mock("@/lib/tools/registry", () => ({ dispatchTool: vi.fn() }));

const PRINCIPAL = { tokenId: "t1", vendorId: "v1", userId: "u1", capabilities: ["vendor:read", "vendor:write"] };

function req(body?: unknown) {
	return new Request("https://app.letterprove.com/api/v1/tools/get_status", {
		method: "POST",
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
}

function params(name: string) {
	return { params: Promise.resolve({ name }) };
}

beforeEach(async () => {
	vi.clearAllMocks();
	const { authenticateOAuthRequest } = await import("@/lib/oauth-auth");
	vi.mocked(authenticateOAuthRequest).mockResolvedValue({ success: true, principal: PRINCIPAL as never });
});

describe("POST /api/v1/tools/{name}", () => {
	it("passes through the 401 an invalid bearer token produces, without reaching the dispatcher", async () => {
		const { authenticateOAuthRequest } = await import("@/lib/oauth-auth");
		const { dispatchTool } = await import("@/lib/tools/registry");
		const unauthorized = new Response(null, { status: 401 });
		vi.mocked(authenticateOAuthRequest).mockResolvedValue({ success: false, response: unauthorized as never });

		const res = await POST(req({}), params("get_status"));

		expect(res.status).toBe(401);
		expect(dispatchTool).not.toHaveBeenCalled();
	});

	it("404s a tool name the registry doesn't recognize", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		vi.mocked(dispatchTool).mockResolvedValue({ kind: "unknown_tool" });

		const res = await POST(req({}), params("nope"));

		expect(res.status).toBe(404);
		expect((await res.json()).detail).toBe("nope");
	});

	it("403s with a www-authenticate scope hint when the capability is denied", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		vi.mocked(dispatchTool).mockResolvedValue({ kind: "denied", capability: "vendor:write" });

		const res = await POST(req({}), params("create_customer"));

		expect(res.status).toBe(403);
		expect(res.headers.get("www-authenticate")).toContain('scope="vendor:write"');
	});

	it("forwards the request body straight through as the tool's args", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		vi.mocked(dispatchTool).mockResolvedValue({ kind: "result", result: { ok: true, body: { customer: {} } } });

		await POST(req({ slug: "acme" }), params("update_customer"));

		expect(dispatchTool).toHaveBeenCalledWith("update_customer", { slug: "acme" }, PRINCIPAL, { origin: null });
	});

	it("treats an unparsable body as empty args rather than failing the request", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		vi.mocked(dispatchTool).mockResolvedValue({ kind: "result", result: { ok: true, body: {} } });

		await POST(new Request("https://app.letterprove.com/api/v1/tools/get_status", { method: "POST" }), params("get_status"));

		expect(dispatchTool).toHaveBeenCalledWith("get_status", {}, PRINCIPAL, { origin: null });
	});

	it("uses the tool's own status on success, defaulting to 200", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		vi.mocked(dispatchTool).mockResolvedValue({
			kind: "result",
			result: { ok: true, status: 201, body: { customer: { slug: "acme" } } },
		});

		const res = await POST(req({}), params("create_customer"));

		expect(res.status).toBe(201);
		expect((await res.json()).customer.slug).toBe("acme");
	});

	// get_install_snippet needs the real serving origin — a wrong one is a
	// silent, expensive failure (see src/lib/vendors/install.ts), so this
	// covers that the route actually derives it from headers rather than
	// leaving dispatchTool's default null in place when a host is present.
	it("derives the request origin from forwarded headers and passes it as context", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		vi.mocked(dispatchTool).mockResolvedValue({ kind: "result", result: { ok: true, body: {} } });

		const forwarded = new Request("https://app.letterprove.com/api/v1/tools/get_install_snippet", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "x-forwarded-host": "vendor.example.com", "x-forwarded-proto": "https" },
		});
		await POST(forwarded, params("get_install_snippet"));

		expect(dispatchTool).toHaveBeenCalledWith("get_install_snippet", {}, PRINCIPAL, {
			origin: "https://vendor.example.com",
		});
	});

	it("carries a failed tool result's own status and body through unchanged", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		vi.mocked(dispatchTool).mockResolvedValue({
			kind: "result",
			result: { ok: false, status: 422, body: { error: "cannot be a customer", kind: "free_mail" } },
		});

		const res = await POST(req({}), params("create_customer"));

		expect(res.status).toBe(422);
		expect((await res.json()).kind).toBe("free_mail");
	});
});
