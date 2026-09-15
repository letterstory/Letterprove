import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

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
vi.mock("@/lib/vendors/verification", () => ({
	checkDomainVerification: vi.fn(),
	expectedRecord: vi.fn(() => "letterprove-site-verification=tok"),
	verificationHosts: vi.fn((d: string) => [`_letterprove.${d}`, d]),
	verificationMessage: vi.fn(() => "checked"),
}));
vi.mock("@/lib/support/slack", () => ({ sendSupportMessage: vi.fn() }));
vi.mock("@/lib/email/consent", () => ({ sendConsentRequest: vi.fn() }));
vi.mock("@/lib/stripe/credentials", () => ({
	saveCredential: vi.fn(),
	connectionFor: vi.fn(),
	disconnect: vi.fn(),
}));
vi.mock("@/lib/stripe/sync", () => ({ syncVendorPayments: vi.fn() }));
vi.mock("@/lib/attest/payment-evidence", () => ({ paymentEvidenceCount: vi.fn() }));

/**
 * A complete customer row, as listCustomers/createCustomer really return one.
 *
 * These mocks used to resolve to `{ id: "c1" }`. Harmless while nothing
 * inspected the payload — but dispatchTool now validates every non-production
 * success against the tool's declared outputSchema, so a stub that no handler
 * could ever produce fails, correctly. A test asserting on an impossible shape
 * was testing the mock, not the code.
 */
function customerRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "c1",
		slug: "acme",
		name: "Acme Inc",
		domain: "acme.com",
		since: "2024-01",
		tier: 1,
		verified: false,
		features: [] as string[],
		consent: "anonymous" as const,
		countersigned_at: null,
		consent_sent_to: null,
		countersigned_by: null,
		consent_declined_at: null,
		consent_decline_count: 0,
		...overrides,
	};
}

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
	domain_verification_token?: string | null;
	proofs_published_at?: string | null;
} | null = {
	key: "lp_live_acme_old",
	slug: "acme",
	name: "Acme Inc",
};
let vendorUpdateError: { message: string } | null = null;
// What was actually written to `vendors`. The update mock is rebuilt on every
// from() call, so an assertion about the payload has nowhere else to look —
// and for publish/unpublish the payload IS the behaviour.
const vendorUpdates: Record<string, unknown>[] = [];

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
				update: vi.fn((patch: Record<string, unknown>) => {
					vendorUpdates.push(patch);
					return { eq: vi.fn(async () => ({ error: vendorUpdateError })) };
				}),
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
	vendorUpdates.length = 0;
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
		vi.mocked(listCustomers).mockResolvedValue({ ok: true, data: [customerRow()] as never });

		const outcome = await dispatchTool("list_customers", {}, principal(["vendor:read"]));

		expect(listCustomers).toHaveBeenCalledWith(FAKE_DB, "v1");
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { customers: [customerRow()] } } });
	});

	it("creates with a 201 and passes the raw args through as the tool's input", async () => {
		const { dispatchTool } = await import("./registry");
		const { createCustomer } = await import("@/lib/vendors/customers");
		vi.mocked(createCustomer).mockResolvedValue({ ok: true, data: customerRow() as never });

		const args = { slug: "acme", name: "Acme", domain: "acme.com", since: "2024-01" };
		const outcome = await dispatchTool("create_customer", args, principal(["vendor:write"]));

		expect(createCustomer).toHaveBeenCalledWith(FAKE_DB, "v1", args);
		expect(outcome).toEqual({
			kind: "result",
			result: { ok: true, status: 201, body: { customer: customerRow() } },
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

	// A vendor who renames a customer loses that customer's counter-signature,
	// and with it the strongest claim in the system. Making them diff the row to
	// find out would hide a consequence they cannot undo alone: re-earning one
	// needs the customer to act again.
	it("tells the caller when an update discarded a counter-signature", async () => {
		const { dispatchTool } = await import("./registry");
		const { updateCustomer } = await import("@/lib/vendors/customers");
		vi.mocked(updateCustomer).mockResolvedValue({
			ok: true,
			data: {
				customer: customerRow({ name: "Globex", countersigned_at: null }) as never,
				countersignatureCleared: true,
				pendingConsentCleared: false,
			},
		});

		const outcome = await dispatchTool("update_customer", { slug: "acme", name: "Globex" }, principal(["vendor:write"]));

		expect(outcome).toEqual({
			kind: "result",
			result: {
				ok: true,
				body: {
					customer: customerRow({ name: "Globex", countersigned_at: null }),
					countersignature_cleared: true,
					pending_consent_cleared: false,
				},
			},
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
		vi.mocked(getVendorStatus).mockResolvedValue({
			ok: true,
			receiving: true,
			installed: true,
			count: 3,
			publishedAt: "2026-01-01T00:00:00.000Z",
		});

		const outcome = await dispatchTool("get_status", {}, principal(["vendor:read"]));

		expect(getVendorStatus).toHaveBeenCalledWith("v1");
		expect(outcome).toEqual({
			kind: "result",
			result: {
				ok: true,
				body: {
					receiving: true,
					installed: true,
					count: 3,
					published: true,
					published_at: "2026-01-01T00:00:00.000Z",
				},
			},
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

	// The same null vendorId means something entirely ordinary when an org is
	// named: this workspace has never linked a vendor. Answering 500 there made
	// the Proofs tab read as "Letterprove is broken" for every unlinked org —
	// which, until a backfill lands, is every org there is.
	it("answers 404 vendor_not_linked, not 500, for a Letterstory org with no vendor", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("list_customers", {}, {
			...principal(["vendor:read"], null),
			orgId: "org-with-no-vendor",
		});
		expect(outcome).toEqual({
			kind: "result",
			result: {
				ok: false,
				status: 404,
				body: {
					error: "vendor_not_linked",
					detail: "This organization has no Letterprove vendor yet. Create one with create_vendor.",
				},
			},
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
			result: {
				ok: true,
				body: {
					snippet: installSnippet(origin, "lp_live_acme_9f2c"),
					origin,
					publishable_key: "lp_live_acme_9f2c",
				},
			},
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

/**
 * Two responses that made the caller do work the handler could have done.
 *
 * Both were flagged in Letterstory's adapter rather than here, which is the
 * tell: a comment on the consuming side apologising for a shape is a defect on
 * the producing side. One forced the consumer to regex a value out of HTML we
 * generate; the other returned a verdict about a domain without saying which
 * domain, so the UI rendered a verified badge with an empty subject beside it.
 */
describe("responses carry what their caller needs", () => {
	it("get_install_snippet returns the publishable key, not just the tag containing it", async () => {
		const { dispatchTool } = await import("./registry");
		vendorRow = { key: "lp_live_acme_new" };

		const outcome = await dispatchTool("get_install_snippet", {}, principal(["vendor:read"]), {
			origin: "https://app.letterprove.com",
		});

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected success");
		const body = outcome.result.body as Record<string, unknown>;

		// Letterstory was doing /data-key="([^"]*)"/ against the snippet to get
		// this back — parsing our own markup for a value we had in hand.
		expect(body.publishable_key).toBe("lp_live_acme_new");
		expect(body.snippet).toContain("lp_live_acme_new");
	});

	it("verify_domain says which domain it checked, on both branches", async () => {
		const { dispatchTool } = await import("./registry");
		const { checkDomainVerification } = await import("@/lib/vendors/verification");

		// Verified branch.
		vendorRow = { domain: "acme.com", domain_verification_token: "tok", domain_verified_at: null };
		vi.mocked(checkDomainVerification).mockResolvedValue({ verified: true } as never);
		const pass = await dispatchTool("verify_domain", {}, principal(["vendor:write"]));
		expect(pass.kind === "result" && pass.result.ok && (pass.result.body as { domain: string }).domain).toBe(
			"acme.com",
		);

		// Unverified branch — the one the setup UI renders, where a missing
		// domain left the card with nothing to name.
		vendorRow = { domain: "acme.com", domain_verification_token: "tok", domain_verified_at: null };
		vi.mocked(checkDomainVerification).mockResolvedValue({ verified: false } as never);
		const fail = await dispatchTool("verify_domain", {}, principal(["vendor:write"]));
		expect(fail.kind === "result" && fail.result.ok && (fail.result.body as { domain: string }).domain).toBe(
			"acme.com",
		);
	});
});

/**
 * Publication: the flip that decides whether any of this is reachable.
 *
 * A vendor is private until someone publishes them (README § A vendor is
 * private until someone publishes them). These two tools are the only way that
 * flag moves, so what matters here is who may move it, what it refuses, and
 * that it writes a date rather than a boolean — the timestamp is what tells a
 * vendor and support when the proofs actually went out.
 */
describe("publish_proofs and unpublish_proofs", () => {
	it("publishes the caller's own vendor and reports when it went public", async () => {
		const { dispatchTool } = await import("./registry");
		vendorRow = { slug: "acme", domain_verified_at: "2026-09-01T00:00:00.000Z", proofs_published_at: null };

		const outcome = await dispatchTool("publish_proofs", {}, principal(["vendor:write"]));

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected success");
		const body = outcome.result.body as { published: boolean; published_at: string; slug: string };
		expect(body.published).toBe(true);
		expect(body.slug).toBe("acme");
		expect(typeof body.published_at).toBe("string");
		expect(vendorUpdates).toEqual([{ proofs_published_at: body.published_at }]);
	});

	/*
	 * Nothing is collected for an unverified domain, so the only document we
	 * could sign for one is a zero — a confident public claim with no evidence
	 * under it, which is the thing this product exists to stop being normal.
	 */
	it("refuses to publish a vendor whose domain is unverified", async () => {
		const { dispatchTool } = await import("./registry");
		vendorRow = { slug: "acme", domain_verified_at: null, proofs_published_at: null };

		const outcome = await dispatchTool("publish_proofs", {}, principal(["vendor:write"]));

		expect(outcome).toEqual({
			kind: "result",
			result: { ok: false, status: 409, body: { error: "domain_not_verified" } },
		});
		expect(vendorUpdates).toEqual([]);
	});

	// Publication is a fact about the past; a retry must not restate it as today.
	it("is idempotent, returning the original date rather than rewriting it", async () => {
		const { dispatchTool } = await import("./registry");
		vendorRow = {
			slug: "acme",
			domain_verified_at: "2026-09-01T00:00:00.000Z",
			proofs_published_at: "2026-09-02T09:00:00.000Z",
		};

		const outcome = await dispatchTool("publish_proofs", {}, principal(["vendor:write"]));

		expect(outcome.kind === "result" && outcome.result.ok && outcome.result.body).toEqual({
			published: true,
			published_at: "2026-09-02T09:00:00.000Z",
			slug: "acme",
		});
		expect(vendorUpdates).toEqual([]);
	});

	it("takes the proofs back down by clearing the date", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("unpublish_proofs", {}, principal(["vendor:write"]));

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected success");
		expect((outcome.result.body as { published: boolean }).published).toBe(false);
		expect(vendorUpdates).toEqual([{ proofs_published_at: null }]);
	});

	/*
	 * Unpublishing stops serving; it cannot un-fetch. A response that only said
	 * `published: false` would invite reading it as a retraction, and a signed
	 * document someone already holds stays valid forever — that is the point of
	 * signing it.
	 */
	it("says out loud that unpublishing does not invalidate anything already fetched", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("unpublish_proofs", {}, principal(["vendor:write"]));

		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected success");
		expect((outcome.result.body as { note: string }).note).toMatch(/remain signed and verifiable/i);
	});

	// Publication is the vendor's own decision about their own row: read-only
	// scope must not be able to make it, and there is no vendor argument to aim
	// at anyone else's.
	it("refuses a read-only caller", async () => {
		const { dispatchTool } = await import("./registry");

		expect(await dispatchTool("publish_proofs", {}, principal(["vendor:read"]))).toEqual({
			kind: "denied",
			capability: "vendor:write",
		});
		expect(await dispatchTool("unpublish_proofs", {}, principal(["vendor:read"]))).toEqual({
			kind: "denied",
			capability: "vendor:write",
		});
	});
});

/**
 * The Stripe tools: tier 3's way back in.
 *
 * Two properties matter more than the happy path here. The first is that the
 * vendor comes from the token, never from an argument, because the thing being
 * stored is a credential and pointing one at somebody else's vendor is the
 * worst outcome available. The second is that the submitted key does not come
 * back out, anywhere, in any shape.
 */
describe("the Stripe tools", () => {
	// A syntactically valid restricted key, distinctive enough that a substring
	// search for it cannot match by accident.
	const LIVE_KEY = "rk_live_ZZQQXXsecretmaterialWXYZ";

	const CONNECTION = {
		last4: "WXYZ",
		livemode: true,
		connectedAt: "2026-09-01T00:00:00.000Z",
		lastSyncedAt: null,
		lastSyncError: null,
	};

	beforeEach(async () => {
		const { saveCredential, connectionFor, disconnect } = await import("@/lib/stripe/credentials");
		const { paymentEvidenceCount } = await import("@/lib/attest/payment-evidence");
		const { syncVendorPayments } = await import("@/lib/stripe/sync");
		vi.mocked(saveCredential).mockResolvedValue({ ok: true, livemode: true, last4: "WXYZ" });
		vi.mocked(connectionFor).mockResolvedValue(CONNECTION);
		vi.mocked(disconnect).mockResolvedValue(true);
		vi.mocked(paymentEvidenceCount).mockResolvedValue(0);
		vi.mocked(syncVendorPayments).mockResolvedValue({
			ok: true,
			matched: 2,
			unmatched: 1,
			testMode: false,
			truncated: false,
		});
	});

	it("connect_stripe never returns the submitted key, in any form", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("connect_stripe", { restricted_key: LIVE_KEY }, principal(["vendor:write"]));

		// The whole response, serialised, including the error branch's detail
		// strings. A masked or truncated echo would still show up here as its
		// own prefix, which is why both halves are checked.
		const serialised = JSON.stringify(outcome);
		expect(serialised).not.toContain(LIVE_KEY);
		expect(serialised).not.toContain("secretmaterial");
		// The suffix Stripe itself shows is the one thing that is allowed
		// through, and only because a vendor with two accounts cannot otherwise
		// tell which key is connected.
		expect(outcome.kind === "result" && outcome.result.ok && (outcome.result.body as { last4: string }).last4).toBe(
			"WXYZ",
		);
	});

	it("connect_stripe resolves the vendor from the caller, never from an argument", async () => {
		const { dispatchTool } = await import("./registry");
		const { saveCredential } = await import("@/lib/stripe/credentials");

		await dispatchTool(
			"connect_stripe",
			// A caller trying to aim someone else's vendor at their key.
			{ restricted_key: LIVE_KEY, vendor_id: "somebody-else", vendor: "victim" },
			principal(["vendor:write"], "v1"),
		);

		expect(saveCredential).toHaveBeenCalledWith("v1", LIVE_KEY);
	});

	it("connect_stripe refuses an unrestricted key without echoing it", async () => {
		const { dispatchTool } = await import("./registry");
		const { saveCredential } = await import("@/lib/stripe/credentials");
		vi.mocked(saveCredential).mockResolvedValue({ ok: false, reason: "unrestricted" });

		const outcome = await dispatchTool(
			"connect_stripe",
			{ restricted_key: "sk_live_ZZQQXXsecretmaterial" },
			principal(["vendor:write"]),
		);

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || outcome.result.ok) throw new Error("expected refusal");
		expect(outcome.result.status).toBe(400);
		expect(outcome.result.body.error).toBe("unrestricted");
		// The detail explains what to do instead. It must not quote what arrived.
		expect(JSON.stringify(outcome.result.body)).not.toContain("secretmaterial");
	});

	it("connect_stripe refuses, rather than stores, when encryption is not configured", async () => {
		// The failure this prevents is a live Stripe credential sitting in a
		// column in the clear because an env var was missing.
		const { dispatchTool } = await import("./registry");
		const { saveCredential, connectionFor } = await import("@/lib/stripe/credentials");
		vi.mocked(saveCredential).mockResolvedValue({ ok: false, reason: "not_configured" });

		const outcome = await dispatchTool("connect_stripe", { restricted_key: LIVE_KEY }, principal(["vendor:write"]));

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || outcome.result.ok) throw new Error("expected refusal");
		expect(outcome.result.status).toBe(503);
		expect(outcome.result.body.error).toBe("not_configured");
		// Nothing was read back, because nothing was written.
		expect(connectionFor).not.toHaveBeenCalled();
	});

	it("connect_stripe rejects a missing key without describing what arrived", async () => {
		const { dispatchTool } = await import("./registry");
		const { saveCredential } = await import("@/lib/stripe/credentials");

		const outcome = await dispatchTool("connect_stripe", {}, principal(["vendor:write"]));

		expect(outcome.kind === "result" && !outcome.result.ok && outcome.result.status).toBe(400);
		expect(saveCredential).not.toHaveBeenCalled();
	});

	it("connect_stripe is a write, so a read-only grant cannot store a credential", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("connect_stripe", { restricted_key: LIVE_KEY }, principal(["vendor:read"]));

		expect(outcome).toEqual({ kind: "denied", capability: "vendor:write" });
	});

	it("get_stripe_connection reports not-connected as an ordinary answer, not a 404", async () => {
		const { dispatchTool } = await import("./registry");
		const { connectionFor } = await import("@/lib/stripe/credentials");
		vi.mocked(connectionFor).mockResolvedValue(null);

		const outcome = await dispatchTool("get_stripe_connection", {}, principal(["vendor:read"]));

		// It is the state of every vendor that has never done this. An error
		// here would have the Proofs tab rendering a fault for a normal state.
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { connected: false } } });
	});

	it("get_stripe_connection distinguishes an unreadable evidence count from zero", async () => {
		const { dispatchTool } = await import("./registry");
		const { paymentEvidenceCount } = await import("@/lib/attest/payment-evidence");
		vi.mocked(paymentEvidenceCount).mockResolvedValue(null);

		const outcome = await dispatchTool("get_stripe_connection", {}, principal(["vendor:read"]));

		// Null, not 0. Rendering a failed read as "0 domains corroborated"
		// tells a vendor their connection is broken while it is fine.
		expect(outcome.kind === "result" && outcome.result.ok && outcome.result.body).toMatchObject({
			connected: true,
			evidence_domains: null,
		});
	});

	it("sync_stripe_payments reports a test-mode key as counts with nothing stored", async () => {
		const { dispatchTool } = await import("./registry");
		const { syncVendorPayments } = await import("@/lib/stripe/sync");
		vi.mocked(syncVendorPayments).mockResolvedValue({
			ok: true,
			matched: 3,
			unmatched: 0,
			testMode: true,
			truncated: false,
		});

		const outcome = await dispatchTool("sync_stripe_payments", {}, principal(["vendor:write"]));

		expect(outcome.kind === "result" && outcome.result.ok && outcome.result.body).toEqual({
			matched: 3,
			unmatched: 0,
			test_mode: true,
			truncated: false,
		});
	});

	it("sync_stripe_payments carries the Invoices-scope warning through to the caller", async () => {
		// The warning exists because the sync deliberately does NOT fail here: a
		// test key stores no evidence, so a missing scope puts nothing at risk
		// and must not page anyone (#142). That makes this string the only way
		// the vendor ever learns there is something to fix before a live key
		// would work, so dropping it at the tool layer would make the problem
		// silent rather than solved.
		const { dispatchTool } = await import("./registry");
		const { syncVendorPayments } = await import("@/lib/stripe/sync");
		vi.mocked(syncVendorPayments).mockResolvedValue({
			ok: true,
			matched: 0,
			unmatched: 0,
			testMode: true,
			truncated: false,
			scopeWarning: "Your Stripe restricted key cannot read Invoices...",
		});

		const outcome = await dispatchTool("sync_stripe_payments", {}, principal(["vendor:write"]));

		expect(outcome.kind === "result" && outcome.result.ok && outcome.result.body).toMatchObject({
			test_mode: true,
			scope_warning: "Your Stripe restricted key cannot read Invoices...",
		});
	});

	it("omits scope_warning entirely when there is nothing to warn about", async () => {
		const { dispatchTool } = await import("./registry");
		const { syncVendorPayments } = await import("@/lib/stripe/sync");
		vi.mocked(syncVendorPayments).mockResolvedValue({
			ok: true,
			matched: 2,
			unmatched: 0,
			testMode: false,
			truncated: false,
		});

		const outcome = await dispatchTool("sync_stripe_payments", {}, principal(["vendor:write"]));
		const body = outcome.kind === "result" && outcome.result.ok ? outcome.result.body : {};

		expect(body).not.toHaveProperty("scope_warning");
	});

	it("sync_stripe_payments tells a caller it has no key rather than failing at Stripe", async () => {
		const { dispatchTool } = await import("./registry");
		const { connectionFor } = await import("@/lib/stripe/credentials");
		const { syncVendorPayments } = await import("@/lib/stripe/sync");
		vi.mocked(connectionFor).mockResolvedValue(null);

		const outcome = await dispatchTool("sync_stripe_payments", {}, principal(["vendor:write"]));

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || outcome.result.ok) throw new Error("expected refusal");
		expect(outcome.result.status).toBe(409);
		expect(outcome.result.body.error).toBe("stripe_not_connected");
		expect(syncVendorPayments).not.toHaveBeenCalled();
	});

	it("sync_stripe_payments relays Stripe's own message when the sync fails", async () => {
		const { dispatchTool } = await import("./registry");
		const { syncVendorPayments } = await import("@/lib/stripe/sync");
		vi.mocked(syncVendorPayments).mockResolvedValue({ ok: false, error: "Expired API Key provided." });

		const outcome = await dispatchTool("sync_stripe_payments", {}, principal(["vendor:write"]));

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || outcome.result.ok) throw new Error("expected failure");
		expect(outcome.result.status).toBe(502);
		// "Expired API Key" is actionable. "Sync failed" is not.
		expect(outcome.result.body.detail).toBe("Expired API Key provided.");
	});

	it("disconnect_stripe succeeds for a vendor that had nothing connected", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("disconnect_stripe", {}, principal(["vendor:write"]));

		// Idempotent: a retry after a network blip must not report a failure
		// that would make a caller think a key is still there.
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { disconnected: true } } });
	});

	it("disconnect_stripe resolves the vendor from the caller", async () => {
		const { dispatchTool } = await import("./registry");
		const { disconnect } = await import("@/lib/stripe/credentials");

		await dispatchTool("disconnect_stripe", { vendor_id: "somebody-else" }, principal(["vendor:write"], "v1"));

		expect(disconnect).toHaveBeenCalledWith("v1");
	});
});
