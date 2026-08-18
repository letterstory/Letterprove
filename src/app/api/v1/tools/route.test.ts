import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/oauth-auth", () => ({ authenticateOAuthRequest: vi.fn() }));

const REQ = new Request("https://app.letterprove.com/api/v1/tools");

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/tools", () => {
	it("passes through the 401 an invalid bearer token produces", async () => {
		const { authenticateOAuthRequest } = await import("@/lib/oauth-auth");
		const unauthorized = new Response(null, { status: 401 });
		vi.mocked(authenticateOAuthRequest).mockResolvedValue({ success: false, response: unauthorized as never });

		const res = await GET(REQ);

		expect(res.status).toBe(401);
	});

	// Every tool the caller CAN'T reach still has to be listed — otherwise a
	// vendor with only vendor:read has no way to discover vendor:write exists
	// short of guessing a tool name and getting a 403.
	it("lists every tool, flagging which ones this token's capabilities cover", async () => {
		const { authenticateOAuthRequest } = await import("@/lib/oauth-auth");
		vi.mocked(authenticateOAuthRequest).mockResolvedValue({
			success: true,
			principal: { tokenId: "t1", vendorId: "v1", userId: "u1", capabilities: ["vendor:read"] } as never,
		});

		const body = await (await GET(REQ)).json();

		const names = body.tools.map((t: { name: string }) => t.name);
		expect(names).toEqual(
			expect.arrayContaining(["list_customers", "create_customer", "update_customer", "delete_customer", "get_status"]),
		);
		const list = body.tools.find((t: { name: string }) => t.name === "list_customers");
		const create = body.tools.find((t: { name: string }) => t.name === "create_customer");
		expect(list.available).toBe(true);
		expect(create.available).toBe(false);
	});
});
