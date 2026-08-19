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
vi.mock("@/lib/staff/promote", () => ({ promoteDomain: vi.fn() }));
vi.mock("@/lib/tiers/report", () => ({ tierReport: vi.fn() }));
vi.mock("@/lib/attest/proofs", () => ({ vendorSlugs: vi.fn() }));

function principal(capabilities: OAuthPrincipal["capabilities"], vendorId: string | null = "v1"): OAuthPrincipal {
	return { tokenId: "t1", vendorId, userId: "u1", capabilities };
}

const FAKE_DB = {} as never;

beforeEach(async () => {
	vi.clearAllMocks();
	// The default principal's user id. Staff tools now require the caller to be
	// on the allowlist as well as to hold the scope.
	process.env.STAFF_USER_IDS = "u1";
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

	// A vendor:* handler is unreachable with a null vendorId in practice (the
	// capability gate above sees to that), but requireVendorId still has to
	// fail safely rather than pass `null` on to a query if that invariant is
	// ever violated by a future bug.
	it("fails safely rather than querying with a null vendorId", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("list_customers", {}, principal(["vendor:read"], null));
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 500, body: { error: "vendor_scope_without_vendor" } },
		});
	});

	it("records a customer from an observed domain, ignoring principal.vendorId", async () => {
		const { dispatchTool } = await import("./registry");
		const { promoteDomain } = await import("@/lib/staff/promote");
		vi.mocked(promoteDomain).mockResolvedValue({ ok: true, slug: "acme", name: "Acme", domain: "acme.com" });

		const outcome = await dispatchTool(
			"record_customer",
			{ vendor: "vantage", domain: "acme.com" },
			principal(["staff:write"], null),
		);

		expect(promoteDomain).toHaveBeenCalledWith("vantage", "acme.com");
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: true, status: 201, body: { customer: { ok: true, slug: "acme", name: "Acme", domain: "acme.com" } } },
		});
	});

	it("rejects record_customer before touching promoteDomain when vendor or domain is missing", async () => {
		const { dispatchTool } = await import("./registry");
		const { promoteDomain } = await import("@/lib/staff/promote");

		const outcome = await dispatchTool("record_customer", { vendor: "vantage" }, principal(["staff:write"], null));

		expect(promoteDomain).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 400, body: { error: "vendor and domain are required" } },
		});
	});

	it("maps a promoteDomain failure reason to its status code", async () => {
		const { dispatchTool } = await import("./registry");
		const { promoteDomain } = await import("@/lib/staff/promote");
		vi.mocked(promoteDomain).mockResolvedValue({
			ok: false,
			reason: "not_observed",
			detail: 'nothing observed for "acme.com" in the publishing window',
		});

		const outcome = await dispatchTool(
			"record_customer",
			{ vendor: "vantage", domain: "acme.com" },
			principal(["staff:write"], null),
		);

		expect(outcome).toEqual({
			kind: "result",
			result: {
				ok: false,
				status: 422,
				body: { error: "not_observed", detail: 'nothing observed for "acme.com" in the publishing window' },
			},
		});
	});

	it("runs tier_report across every vendor when none is named", async () => {
		const { dispatchTool } = await import("./registry");
		const { vendorSlugs } = await import("@/lib/attest/proofs");
		const { tierReport } = await import("@/lib/tiers/report");
		vi.mocked(vendorSlugs).mockResolvedValue(["vantage", "acme"]);
		vi.mocked(tierReport).mockImplementation(async (slug) =>
			slug === "acme" ? null : ({ vendor: slug, observed: 1, attributable: 1, unpublishedEvidence: 0, published: 1, rows: [] } as never),
		);

		const outcome = await dispatchTool("tier_report", {}, principal(["staff:read"], null));

		expect(vendorSlugs).toHaveBeenCalled();
		expect(tierReport).toHaveBeenCalledWith("vantage");
		expect(tierReport).toHaveBeenCalledWith("acme");
		expect(outcome).toMatchObject({
			kind: "result",
			result: {
				ok: true,
				body: {
					vendors: [{ vendor: "vantage", observed: 1, attributable: 1, unpublishedEvidence: 0, published: 1, rows: [] }],
					unreadable: ["acme"],
				},
			},
		});
	});

	it("scopes tier_report to one vendor when named, without listing every slug", async () => {
		const { dispatchTool } = await import("./registry");
		const { vendorSlugs } = await import("@/lib/attest/proofs");
		const { tierReport } = await import("@/lib/tiers/report");
		vi.mocked(tierReport).mockResolvedValue({
			vendor: "vantage",
			observed: 2,
			attributable: 2,
			unpublishedEvidence: 1,
			published: 1,
			rows: [],
		} as never);

		const outcome = await dispatchTool("tier_report", { vendor: "vantage" }, principal(["staff:read"], null));

		expect(vendorSlugs).not.toHaveBeenCalled();
		expect(tierReport).toHaveBeenCalledWith("vantage");
		expect(outcome).toMatchObject({
			kind: "result",
			result: { ok: true, body: { vendors: [{ vendor: "vantage" }] } },
		});
	});

	it("denies record_customer/tier_report without staff capability, before the handler runs", async () => {
		const { dispatchTool } = await import("./registry");
		const { promoteDomain } = await import("@/lib/staff/promote");

		const outcome = await dispatchTool(
			"record_customer",
			{ vendor: "vantage", domain: "acme.com" },
			principal(["vendor:read", "vendor:write"], null),
		);

		expect(outcome).toEqual({ kind: "denied", capability: "staff:write" });
		expect(promoteDomain).not.toHaveBeenCalled();
	});
});

/**
 * A staff capability inside a token is not proof of being staff.
 *
 * The CLI client is registered with `allowed_scopes: ['*']`, which expands to
 * every known capability — staff:* included — and the consent flow narrowed only
 * VENDOR scopes, by membership. So an ordinary `letterprove login` handed
 * staff:read and staff:write to whoever signed in, and signup is open. Those
 * scopes read every vendor's withheld customer domains and write customer
 * records on any vendor's behalf.
 *
 * Enforced at dispatch and not only at consent, because consent governs future
 * grants; tokens already issued carry staff scopes until they expire, and this
 * is the only thing standing in front of those.
 */
describe("staff tools require an allowlisted user, not just the scope", () => {
	beforeEach(() => {
		process.env.STAFF_USER_IDS = "staff-1";
	});

	it.each(["tier_report", "record_customer"] as const)(
		"denies %s to a signed-in user who holds the scope but is not staff",
		async (tool) => {
			const { dispatchTool } = await import("./registry");
			const { tierReport } = await import("@/lib/tiers/report");
			const { promoteDomain } = await import("@/lib/staff/promote");

			const outcome = await dispatchTool(
				tool,
				{ vendor: "lettertrace", domain: "juvare.com" },
				principal(["staff:read", "staff:write"], null),
			);

			expect(outcome.kind).toBe("denied");
			// Denied before any work happens — no withheld domain is even read.
			expect(tierReport).not.toHaveBeenCalled();
			expect(promoteDomain).not.toHaveBeenCalled();
		},
	);

	it("allows a staff tool for an allowlisted user", async () => {
		const { dispatchTool } = await import("./registry");
		const p = { tokenId: "t1", vendorId: null, userId: "staff-1", capabilities: ["staff:read"] } as OAuthPrincipal;
		const outcome = await dispatchTool("tier_report", { vendor: "lettertrace" }, p);
		expect(outcome.kind).toBe("result");
	});

	// Fails closed: an unconfigured deployment has no staff, so no staff tool runs.
	it("denies staff tools when no allowlist is configured", async () => {
		delete process.env.STAFF_USER_IDS;
		const { dispatchTool } = await import("./registry");
		const p = { tokenId: "t1", vendorId: null, userId: "staff-1", capabilities: ["staff:read"] } as OAuthPrincipal;
		expect((await dispatchTool("tier_report", {}, p)).kind).toBe("denied");
	});

	// The vendor path must be untouched by this.
	it("still lets an ordinary vendor call vendor tools", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("list_customers", {}, principal(["vendor:read"]));
		expect(outcome.kind).toBe("result");
	});
});
