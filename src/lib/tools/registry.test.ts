import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/core";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/vendors/customers", () => ({
	listCustomers: vi.fn(),
	createCustomer: vi.fn(),
	updateCustomer: vi.fn(),
	deleteCustomer: vi.fn(),
}));
vi.mock("@/lib/vendors/status", () => ({ getVendorStatus: vi.fn() }));

function principal(capabilities: OAuthPrincipal["capabilities"]): OAuthPrincipal {
	return { tokenId: "t1", vendorId: "v1", userId: "u1", capabilities };
}

const FAKE_DB = {} as never;

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(FAKE_DB);
});

// A capability check that only ran on the routes, not the dispatcher itself,
// would silently stop protecting anything the moment a second transport (MCP)
// called dispatchTool directly.
describe("dispatchTool", () => {
	it("reports an unknown tool by name, not a generic failure", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("nonexistent_tool", {}, principal(["vendor:read", "vendor:write"]));
		expect(outcome).toEqual({ kind: "unknown_tool" });
	});

	it("denies a tool the token's capabilities don't cover, before the handler runs", async () => {
		const { dispatchTool } = await import("./registry");
		const { createCustomer } = await import("@/lib/vendors/customers");
		const outcome = await dispatchTool("create_customer", { slug: "acme" }, principal(["vendor:read"]));
		expect(outcome).toEqual({ kind: "denied", capability: "vendor:write" });
		expect(createCustomer).not.toHaveBeenCalled();
	});

	it("routes list_customers to the shared service, scoped by the token's vendor", async () => {
		const { dispatchTool } = await import("./registry");
		const { listCustomers } = await import("@/lib/vendors/customers");
		vi.mocked(listCustomers).mockResolvedValue({ ok: true, data: [{ id: "c1" }] as never });

		const outcome = await dispatchTool("list_customers", {}, principal(["vendor:read"]));

		expect(listCustomers).toHaveBeenCalledWith(FAKE_DB, "v1");
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { customers: [{ id: "c1" }] } } });
	});

	it("creates with a 201 and passes the raw args through as the tool's input", async () => {
		const { dispatchTool } = await import("./registry");
		const { createCustomer } = await import("@/lib/vendors/customers");
		vi.mocked(createCustomer).mockResolvedValue({ ok: true, data: { id: "c1", slug: "acme" } as never });

		const args = { slug: "acme", name: "Acme", domain: "acme.com", since: "2024-01" };
		const outcome = await dispatchTool("create_customer", args, principal(["vendor:write"]));

		expect(createCustomer).toHaveBeenCalledWith(FAKE_DB, "v1", args);
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: true, status: 201, body: { customer: { id: "c1", slug: "acme" } } },
		});
	});

	it("rejects update_customer before touching the db when slug is missing", async () => {
		const { dispatchTool } = await import("./registry");
		const { updateCustomer } = await import("@/lib/vendors/customers");

		const outcome = await dispatchTool("update_customer", { name: "New Name" }, principal(["vendor:write"]));

		expect(updateCustomer).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 400, body: { error: "slug is required" } },
		});
	});

	it("passes a domain-gate refusal from the shared service straight through", async () => {
		const { dispatchTool } = await import("./registry");
		const { updateCustomer } = await import("@/lib/vendors/customers");
		vi.mocked(updateCustomer).mockResolvedValue({
			ok: false,
			status: 422,
			body: { error: '"gmail.com" cannot be a customer', reason: "consumer mailbox provider", kind: "free_mail" },
		});

		const outcome = await dispatchTool(
			"update_customer",
			{ slug: "acme", domain: "gmail.com" },
			principal(["vendor:write"]),
		);

		expect(outcome).toEqual({
			kind: "result",
			result: {
				ok: false,
				status: 422,
				body: { error: '"gmail.com" cannot be a customer', reason: "consumer mailbox provider", kind: "free_mail" },
			},
		});
	});

	// Not 204: this seam always answers with a JSON body (see client.mjs's
	// res.json() on every response), so success has to be a flag, not silence.
	it("reports delete_customer as a JSON flag rather than an empty 204", async () => {
		const { dispatchTool } = await import("./registry");
		const { deleteCustomer } = await import("@/lib/vendors/customers");
		vi.mocked(deleteCustomer).mockResolvedValue({ ok: true, data: { id: "c1" } });

		const outcome = await dispatchTool("delete_customer", { slug: "acme" }, principal(["vendor:write"]));

		expect(deleteCustomer).toHaveBeenCalledWith(FAKE_DB, "v1", "acme");
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { deleted: true } } });
	});

	it("reports get_status by delegating to the shared status service", async () => {
		const { dispatchTool } = await import("./registry");
		const { getVendorStatus } = await import("@/lib/vendors/status");
		vi.mocked(getVendorStatus).mockResolvedValue({ ok: true, receiving: true, count: 3 });

		const outcome = await dispatchTool("get_status", {}, principal(["vendor:read"]));

		expect(getVendorStatus).toHaveBeenCalledWith("v1");
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { receiving: true, count: 3 } } });
	});

	it("answers storage_unavailable rather than throwing when dbClient() is unconfigured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("list_customers", {}, principal(["vendor:read"]));

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 503, body: { error: "storage_unavailable" } },
		});
	});
});
