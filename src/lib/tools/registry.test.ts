import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/core";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/vendors/customers", () => ({
	listCustomers: vi.fn(),
	createCustomer: vi.fn(),
	updateCustomer: vi.fn(),
	deleteCustomer: vi.fn(),
	generateConsentLink: vi.fn(),
	clearConsentToken: vi.fn(),
}));
vi.mock("@/lib/vendors/status", () => ({ getVendorStatus: vi.fn() }));
vi.mock("@/lib/staff/promote", () => ({ promoteDomain: vi.fn() }));
vi.mock("@/lib/tiers/report", () => ({ tierReport: vi.fn() }));
vi.mock("@/lib/attest/proofs", () => ({ vendorSlugs: vi.fn(), vendorSnapshots: vi.fn() }));
vi.mock("@/lib/vendors/keys", () => ({ generateKey: vi.fn() }));
vi.mock("@/lib/support/slack", () => ({ sendSupportMessage: vi.fn() }));
vi.mock("@/lib/email/consent", () => ({ sendConsentRequest: vi.fn() }));

function principal(capabilities: OAuthPrincipal["capabilities"], vendorId: string | null = "v1"): OAuthPrincipal {
	return { tokenId: "t1", vendorId, userId: "u1", capabilities };
}

// dispatchTool now re-verifies vendor_members before running any vendor:*
// handler (consent no longer checks membership — see the consent route), so
// FAKE_DB needs a real .from().select().eq().eq().maybeSingle() chain, not an
// empty object. It stays the exact instance passed to toHaveBeenCalledWith
// below — only its shape grew. Defaults to "is a member"; tests that need the
// opposite set membershipRow = null first.
let membershipRow: { vendor_id: string } | null = { vendor_id: "v1" };

// get_install_snippet/rotate_key/list_snapshots query the `vendors` table
// directly (single .eq().maybeSingle(), not the double-.eq() membership
// shape above), so `from` branches on the table name. Defaults to a
// resolvable vendor row; tests that need "not found" set vendorRow = null.
let vendorRow: {
	key?: string;
	slug?: string;
	name?: string;
	domain?: string;
	category?: string;
	domain_verified_at?: string | null;
} | null = {
	key: "lp_live_acme_old",
	slug: "acme",
	name: "Acme Inc",
};
let vendorUpdateError: { message: string } | null = null;

// submit_support_request resolves the caller's email off a bearer token via
// the service-role client's admin API — there's no cookie session to read it
// from (see the tool's own comment). Defaults to a resolvable user; tests
// that need the fallback set authUserRow = null.
let authUserRow: { email?: string } | null = { email: "u1@example.com" };

const FAKE_DB = {
	auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: authUserRow } })) } },
	from: vi.fn((table: string) => {
		if (table === "vendors") {
			return {
				select: vi.fn(() => ({
					eq: vi.fn(() => ({
						maybeSingle: vi.fn(async () => ({ data: vendorRow })),
					})),
				})),
				update: vi.fn(() => ({
					eq: vi.fn(async () => ({ error: vendorUpdateError })),
				})),
			};
		}
		return {
			select: vi.fn(() => ({
				eq: vi.fn(() => ({
					eq: vi.fn(() => ({
						maybeSingle: vi.fn(async () => ({ data: membershipRow })),
					})),
				})),
			})),
		};
	}),
} as never;

beforeEach(async () => {
	vi.clearAllMocks();
	// The default principal's user id. Staff tools now require the caller to be
	// on the allowlist as well as to hold the scope.
	process.env.STAFF_USER_IDS = "u1";
	membershipRow = { vendor_id: "v1" };
	vendorRow = { key: "lp_live_acme_old", slug: "acme" };
	vendorUpdateError = null;
	authUserRow = { email: "u1@example.com" };
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

	it("emails the consent link and never returns the token to the caller", async () => {
		const { dispatchTool } = await import("./registry");
		const { generateConsentLink } = await import("@/lib/vendors/customers");
		const { sendConsentRequest } = await import("@/lib/email/consent");
		vi.mocked(generateConsentLink).mockResolvedValue({
			ok: true,
			data: {
				token: "tok123",
				expiresAt: "2026-08-28T06:00:00.000Z",
				sentTo: "ops@acme-customer.com",
				customerName: "Acme Customer",
			},
		});
		vi.mocked(sendConsentRequest).mockResolvedValue({ ok: true });

		const outcome = await dispatchTool(
			"request_consent",
			{ slug: "acme", contact_email: "ops@acme-customer.com" },
			principal(["vendor:write"]),
			{ origin: "https://app.letterprove.com" },
		);

		expect(generateConsentLink).toHaveBeenCalledWith(FAKE_DB, "v1", "acme", "ops@acme-customer.com");
		expect(vi.mocked(sendConsentRequest).mock.calls[0][0].url).toBe(
			"https://app.letterprove.com/attest/acme/acme/consent?token=tok123",
		);
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: true, body: { sentTo: "ops@acme-customer.com", expiresAt: "2026-08-28T06:00:00.000Z" } },
		});

		// The CLI is a vendor-controlled client, so leaking the token here is the
		// same hole as leaking it from the dashboard route.
		expect(JSON.stringify(outcome)).not.toContain("tok123");
	});

	it("rolls the token back when the consent email fails to send", async () => {
		const { dispatchTool } = await import("./registry");
		const { generateConsentLink, clearConsentToken } = await import("@/lib/vendors/customers");
		const { sendConsentRequest } = await import("@/lib/email/consent");
		vi.mocked(generateConsentLink).mockResolvedValue({
			ok: true,
			data: {
				token: "tok123",
				expiresAt: "2026-08-28T06:00:00.000Z",
				sentTo: "ops@acme-customer.com",
				customerName: "Acme Customer",
			},
		});
		vi.mocked(sendConsentRequest).mockResolvedValue({ ok: false, error: "Couldn't send the consent email." });

		const outcome = await dispatchTool(
			"request_consent",
			{ slug: "acme", contact_email: "ops@acme-customer.com" },
			principal(["vendor:write"]),
			{ origin: "https://app.letterprove.com" },
		);

		expect(clearConsentToken).toHaveBeenCalledWith(FAKE_DB, "v1", "acme", "tok123");
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 502, body: { error: "Couldn't send the consent email." } },
		});
	});

	it("refuses request_consent with no origin to build an absolute link from", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"request_consent",
			{ slug: "acme", contact_email: "ops@acme-customer.com" },
			principal(["vendor:write"]),
		);

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 400, body: { error: "origin_unavailable" } },
		});
	});

	it("requires a slug for request_consent", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("request_consent", {}, principal(["vendor:write"]), { origin: "https://app.letterprove.com" });

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 400, body: { error: "slug is required" } },
		});
	});

	it("reports get_status by delegating to the shared status service", async () => {
		const { dispatchTool } = await import("./registry");
		const { getVendorStatus } = await import("@/lib/vendors/status");
		vi.mocked(getVendorStatus).mockResolvedValue({ ok: true, receiving: true, installed: true, count: 3 });

		const outcome = await dispatchTool("get_status", {}, principal(["vendor:read"]));

		expect(getVendorStatus).toHaveBeenCalledWith("v1");
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: true, body: { receiving: true, installed: true, count: 3 } },
		});
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

	/*
	 * list_observed reports the same rows tier_report does, at vendor:read
	 * instead of staff:read. The whole reason it is a separate tool rather than
	 * a role check on the existing one is that tier_report takes a slug and will
	 * answer for anybody — so the tests that matter here are about where the
	 * slug comes from, not about the row shape.
	 */
	it("lists observed domains for the caller's OWN vendor", async () => {
		const { dispatchTool } = await import("./registry");
		const { tierReport } = await import("@/lib/tiers/report");
		vi.mocked(tierReport).mockResolvedValue({
			vendor: "acme",
			observed: 3,
			attributable: 2,
			unpublishedEvidence: 1,
			published: 1,
			rows: [
				{
					domain: "widgets.co",
					kind: "company",
					sessions: 4,
					signups: 1,
					logins: 0,
					customer: null,
					assertedTier: null,
					earnedTier: null,
					consent: null,
					status: "no-customer-record",
					detail: "Observed, but nobody has recorded it as a customer.",
				},
			],
		} as never);

		const outcome = await dispatchTool("list_observed", {}, principal(["vendor:read"]));

		// vendorRow.slug — resolved from the principal's vendor id, never an argument.
		expect(tierReport).toHaveBeenCalledWith("acme");
		expect(outcome).toMatchObject({
			kind: "result",
			result: {
				ok: true,
				body: {
					observed: 3,
					attributable: 2,
					awaiting: 1,
					published: 1,
					domains: [{ domain: "widgets.co", status: "no-customer-record", sessions: 4 }],
				},
			},
		});
	});

	/*
	 * The security property, asserted directly: there is no argument that can
	 * redirect this at somebody else's data. Passing a foreign slug must be
	 * ignored, not honoured — that is the difference between this tool and
	 * exposing tier_report to vendors.
	 */
	it("ignores a vendor slug passed in args, and reports on the caller's own", async () => {
		const { dispatchTool } = await import("./registry");
		const { tierReport } = await import("@/lib/tiers/report");
		vi.mocked(tierReport).mockResolvedValue({
			vendor: "acme",
			observed: 0,
			attributable: 0,
			unpublishedEvidence: 0,
			published: 0,
			rows: [],
		} as never);

		await dispatchTool("list_observed", { vendor: "lettertrace" }, principal(["vendor:read"]));

		expect(tierReport).toHaveBeenCalledWith("acme");
		expect(tierReport).not.toHaveBeenCalledWith("lettertrace");
	});

	/*
	 * A telemetry read that FAILED is not "no companies observed". Answering
	 * with zeros would tell a vendor their install is broken when it may be
	 * fine — the same distinction the aggregate makes when it refuses to
	 * publish rather than publish a zero.
	 */
	it("reports unavailable rather than zero when telemetry can't be read", async () => {
		const { dispatchTool } = await import("./registry");
		const { tierReport } = await import("@/lib/tiers/report");
		vi.mocked(tierReport).mockResolvedValue(null);

		const outcome = await dispatchTool("list_observed", {}, principal(["vendor:read"]));

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 503, body: { error: "telemetry_unavailable" } },
		});
	});

	it("denies list_observed without vendor:read", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("list_observed", {}, principal(["vendor:write"]));

		expect(outcome).toEqual({ kind: "denied", capability: "vendor:read" });
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

	it("builds an install snippet from the caller's vendor key and the request's own origin", async () => {
		vendorRow = { key: "lp_live_acme_9f2c" };
		const { dispatchTool } = await import("./registry");
		const { installSnippet } = await import("@/lib/vendors/install");
		const origin = "https://acme.example.com";

		const outcome = await dispatchTool("get_install_snippet", {}, principal(["vendor:read"]), { origin });

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: true, body: { snippet: installSnippet(origin, "lp_live_acme_9f2c"), origin } },
		});
	});

	// A tool call has no browser request behind it — origin can legitimately be
	// unavailable — and a wrong host in the snippet is silently expensive (see
	// src/lib/vendors/install.ts), so this must refuse rather than guess.
	it("refuses get_install_snippet rather than guess when the origin is unavailable", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("get_install_snippet", {}, principal(["vendor:read"]));

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 400, body: { error: "origin_unavailable" } },
		});
	});

	it("rotates the caller's key to a freshly generated one in the same slug family", async () => {
		vendorRow = { slug: "acme" };
		const { dispatchTool } = await import("./registry");
		const { generateKey } = await import("@/lib/vendors/keys");
		vi.mocked(generateKey).mockReturnValue("lp_live_acme_newkey");

		const outcome = await dispatchTool("rotate_key", {}, principal(["vendor:write"]));

		expect(generateKey).toHaveBeenCalledWith("acme");
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { key: "lp_live_acme_newkey" } } });
	});

	it("rejects update_vendor before touching the db when no fields are given", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("update_vendor", {}, principal(["vendor:write"]));

		const fromCalls = (FAKE_DB as unknown as { from: { mock: { calls: unknown[][] } } }).from.mock.calls;
		expect(fromCalls.some(([table]) => table === "vendors")).toBe(false);
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 400, body: { error: "at least one of name, domain, category is required" } },
		});
	});

	it("updates the caller's vendor account and returns the merged row", async () => {
		vendorRow = { slug: "acme", name: "Old Name", domain: "old.example.com", category: "retail" };
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"update_vendor",
			{ name: "New Name", domain: "new.example.com" },
			principal(["vendor:write"]),
		);

		expect(outcome).toEqual({
			kind: "result",
			result: {
				ok: true,
				body: {
					vendor: {
						slug: "acme",
						name: "New Name",
						domain: "new.example.com",
						category: "retail",
						// The domain moved, so the proof of control for the old
						// one no longer says anything about this row.
						domain_verified_at: null,
					},
				},
			},
		});
	});

	it("clears domain verification when the domain changes", async () => {
		// Otherwise: verify a domain you own, repoint the row at one you do
		// not, keep the verified flag. That is the whole attack DNS
		// verification exists to stop.
		vendorRow = {
			slug: "acme",
			name: "Acme",
			domain: "acme.com",
			category: "retail",
			domain_verified_at: "2026-08-01T00:00:00.000Z",
		};
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("update_vendor", { domain: "victim.com" }, principal(["vendor:write"]));

		expect(outcome).toMatchObject({
			result: { ok: true, body: { vendor: { domain: "victim.com", domain_verified_at: null } } },
		});
	});

	it("keeps verification when the domain is unchanged", async () => {
		// Renaming or recategorising says nothing about domain control, so it
		// must not cost a vendor their verified status.
		vendorRow = {
			slug: "acme",
			name: "Acme",
			domain: "acme.com",
			category: "retail",
			domain_verified_at: "2026-08-01T00:00:00.000Z",
		};
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("update_vendor", { name: "Acme Inc" }, principal(["vendor:write"]));

		expect(outcome).toMatchObject({
			result: { ok: true, body: { vendor: { domain_verified_at: "2026-08-01T00:00:00.000Z" } } },
		});
	});

	it("normalises a domain before storing it, like signup does", async () => {
		vendorRow = { slug: "acme", name: "Acme", domain: "acme.com", category: "retail" };
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"update_vendor",
			{ domain: "https://New.Example.com/path" },
			principal(["vendor:write"]),
		);

		expect(outcome).toMatchObject({
			result: { ok: true, body: { vendor: { domain: "new.example.com" } } },
		});
	});

	it("rejects a domain the collector could never match", async () => {
		vendorRow = { slug: "acme", name: "Acme", domain: "acme.com", category: "retail" };
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("update_vendor", { domain: "my company" }, principal(["vendor:write"]));

		expect(outcome).toMatchObject({ result: { ok: false, status: 400 } });
	});

	it("404s update_vendor when the caller's vendor row is gone", async () => {
		vendorRow = null;
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("update_vendor", { name: "New Name" }, principal(["vendor:write"]));

		expect(outcome).toEqual({ kind: "result", result: { ok: false, status: 404, body: { error: "not_found" } } });
	});

	it("surfaces a db write failure from update_vendor as a 400", async () => {
		vendorRow = { slug: "acme", name: "Old Name", domain: "old.example.com", category: "retail" };
		vendorUpdateError = { message: "constraint violation" };
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("update_vendor", { category: "media" }, principal(["vendor:write"]));

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 400, body: { error: "constraint violation" } },
		});
		vendorUpdateError = null;
	});

	it("lists snapshot summaries for every one of the caller's customers by default", async () => {
		vendorRow = { slug: "acme" };
		const { dispatchTool } = await import("./registry");
		const { vendorSnapshots } = await import("@/lib/attest/proofs");
		vi.mocked(vendorSnapshots).mockResolvedValue([
			{ slug: "c1", length: 3, current: { published_at: "2026-08-01", verified: true, sessions_30d: 40, features: [] } },
		] as never);

		const outcome = await dispatchTool("list_snapshots", {}, principal(["vendor:read"]));

		expect(vendorSnapshots).toHaveBeenCalledWith("acme", undefined);
		expect(outcome).toMatchObject({
			kind: "result",
			result: { ok: true, body: { snapshots: [{ slug: "c1", length: 3 }] } },
		});
	});

	it("scopes list_snapshots to one customer when named in args", async () => {
		vendorRow = { slug: "acme" };
		const { dispatchTool } = await import("./registry");
		const { vendorSnapshots } = await import("@/lib/attest/proofs");
		vi.mocked(vendorSnapshots).mockResolvedValue([]);

		await dispatchTool("list_snapshots", { customer: "c1" }, principal(["vendor:read"]));

		expect(vendorSnapshots).toHaveBeenCalledWith("acme", "c1");
	});

	it("submits a support request with the caller's vendor and resolved email", async () => {
		vendorRow = { slug: "acme", name: "Acme" };
		authUserRow = { email: "vendor@acme.com" };
		const { dispatchTool } = await import("./registry");
		const { sendSupportMessage } = await import("@/lib/support/slack");
		vi.mocked(sendSupportMessage).mockResolvedValue({ ok: true });

		const outcome = await dispatchTool("submit_support_request", { message: "help please" }, principal(["vendor:write"]));

		expect(sendSupportMessage).toHaveBeenCalledWith({
			vendorName: "Acme",
			vendorSlug: "acme",
			userEmail: "vendor@acme.com",
			message: "help please",
		});
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { ok: true } } });
	});

	it("rejects submit_support_request before touching the db when message is missing", async () => {
		const { dispatchTool } = await import("./registry");
		const { sendSupportMessage } = await import("@/lib/support/slack");

		const outcome = await dispatchTool("submit_support_request", {}, principal(["vendor:write"]));

		const fromCalls = (FAKE_DB as unknown as { from: { mock: { calls: unknown[][] } } }).from.mock.calls;
		expect(fromCalls.some(([table]) => table === "vendors")).toBe(false);
		expect(sendSupportMessage).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 400, body: { error: "message is required" } },
		});
	});

	it("rejects submit_support_request over the message length limit", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"submit_support_request",
			{ message: "x".repeat(4001) },
			principal(["vendor:write"]),
		);

		expect(outcome).toMatchObject({ result: { ok: false, status: 400 } });
	});

	it("404s submit_support_request when the caller's vendor row is gone", async () => {
		vendorRow = null;
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("submit_support_request", { message: "help" }, principal(["vendor:write"]));

		expect(outcome).toEqual({ kind: "result", result: { ok: false, status: 404, body: { error: "not_found" } } });
	});

	it("falls back to 'unknown' when the caller's email can't be resolved", async () => {
		vendorRow = { slug: "acme", name: "Acme" };
		authUserRow = null;
		const { dispatchTool } = await import("./registry");
		const { sendSupportMessage } = await import("@/lib/support/slack");
		vi.mocked(sendSupportMessage).mockResolvedValue({ ok: true });

		await dispatchTool("submit_support_request", { message: "help" }, principal(["vendor:write"]));

		expect(sendSupportMessage).toHaveBeenCalledWith(expect.objectContaining({ userEmail: "unknown" }));
	});

	it("surfaces a Slack delivery failure from submit_support_request as a 502", async () => {
		vendorRow = { slug: "acme", name: "Acme" };
		const { dispatchTool } = await import("./registry");
		const { sendSupportMessage } = await import("@/lib/support/slack");
		vi.mocked(sendSupportMessage).mockResolvedValue({ ok: false, error: "Failed to send your message. Please try again." });

		const outcome = await dispatchTool("submit_support_request", { message: "help" }, principal(["vendor:write"]));

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 502, body: { error: "Failed to send your message. Please try again." } },
		});
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
				{ vendor: "lettertrace", domain: "globex.com" },
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

/**
 * A vendor capability inside a token is not proof of current membership,
 * mirroring the staff case above — consent no longer verifies vendor_members
 * before minting a grant (see the consent route), so this is the only check
 * standing in front of a token whose vendor_id the caller doesn't (or no
 * longer does) belong to.
 */
describe("vendor tools require current membership, not just the scope", () => {
	it("denies a vendor tool when the caller isn't a member of the token's vendor", async () => {
		membershipRow = null;
		const { dispatchTool } = await import("./registry");
		const { listCustomers } = await import("@/lib/vendors/customers");

		const outcome = await dispatchTool("list_customers", {}, principal(["vendor:read"]));

		expect(outcome).toEqual({ kind: "denied", capability: "vendor:read" });
		expect(listCustomers).not.toHaveBeenCalled();
	});

	it("allows a vendor tool for a current member", async () => {
		membershipRow = { vendor_id: "v1" };
		const { dispatchTool } = await import("./registry");
		const { listCustomers } = await import("@/lib/vendors/customers");
		vi.mocked(listCustomers).mockResolvedValue({ ok: true, data: [] as never });

		const outcome = await dispatchTool("list_customers", {}, principal(["vendor:read"]));

		expect(outcome.kind).toBe("result");
	});
});
