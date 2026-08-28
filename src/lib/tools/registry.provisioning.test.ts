import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchTool } from "./registry";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";
import type { VendorFixture } from "@/lib/fixtures/vendors";
import type { ProvisionResult } from "@/lib/vendors/provision";

const provisionVendorForOrg = vi.fn<(orgId: string, input: { name: string; domain: string }) => Promise<ProvisionResult>>();
vi.mock("@/lib/vendors/provision", () => ({ provisionVendorForOrg: (o: string, i: { name: string; domain: string }) => provisionVendorForOrg(o, i) }));

const findVendorByOrg = vi.fn<(orgId: string) => Promise<VendorFixture | undefined>>();
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/fixtures/vendors")>();
	return { ...actual, findVendorByOrg: (o: string) => findVendorByOrg(o) };
});

const maybeSingle = vi.fn<() => Promise<{ data: Record<string, unknown> | null }>>();
// `.eq()` returns a node that supports BOTH a further `.eq()` (dispatchTool's
// two-key vendor_members membership check) and a terminal `.maybeSingle()`
// (record_observed's single-key slug lookup).
vi.mock("@/lib/db/client", () => {
	// maybeSingle is referenced lazily (behind an arrow) because vi.mock is
	// hoisted above the const and would otherwise read it before initialization.
	const node: { eq: () => typeof node; maybeSingle: () => unknown } = {
		eq: () => node,
		maybeSingle: () => maybeSingle(),
	};
	return { dbClient: () => ({ from: () => ({ select: () => node }) }) };
});

const promoteDomain = vi.fn();
vi.mock("@/lib/staff/promote", () => ({ promoteDomain: (s: string, d: string) => promoteDomain(s, d) }));

const ORG = "11111111-1111-1111-1111-111111111111";

function service(over: Partial<OAuthPrincipal> = {}): OAuthPrincipal {
	return { tokenId: "letterstory-service", vendorId: null, userId: "letterstory-service", capabilities: ["vendor:read", "vendor:write"], orgId: ORG, ...over };
}
function vendor(): VendorFixture {
	return { id: "v1", slug: "acme", name: "Acme", domain: "acme.com", category: "software", key: "k", domainVerified: false, customers: [] };
}

beforeEach(() => {
	provisionVendorForOrg.mockReset();
	findVendorByOrg.mockReset();
	maybeSingle.mockReset().mockResolvedValue({ data: { slug: "acme" } });
	promoteDomain.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("find_vendor_by_org", () => {
	it("reports a linked vendor", async () => {
		findVendorByOrg.mockResolvedValue(vendor());
		const o = await dispatchTool("find_vendor_by_org", {}, service());
		expect(o).toMatchObject({ kind: "result", result: { ok: true, body: { linked: true, slug: "acme", domain: "acme.com" } } });
	});

	it("reports unlinked for an org with no vendor", async () => {
		findVendorByOrg.mockResolvedValue(undefined);
		const o = await dispatchTool("find_vendor_by_org", {}, service());
		expect(o).toMatchObject({ kind: "result", result: { ok: true, body: { linked: false } } });
	});

	it("403s a caller with no org context (a CLI token)", async () => {
		const o = await dispatchTool("find_vendor_by_org", {}, service({ orgId: undefined }));
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 403 } });
		expect(findVendorByOrg).not.toHaveBeenCalled();
	});

	it("is denied at the capability gate without vendor:read", async () => {
		const o = await dispatchTool("find_vendor_by_org", {}, service({ capabilities: ["staff:read"] }));
		expect(o.kind).toBe("denied");
	});
});

describe("create_vendor", () => {
	it("provisions and returns the linked vendor (201)", async () => {
		provisionVendorForOrg.mockResolvedValue({ ok: true, vendorId: "v1", slug: "acme", domain: "acme.com" });
		const o = await dispatchTool("create_vendor", { name: "Acme", domain: "acme.com" }, service());
		expect(provisionVendorForOrg).toHaveBeenCalledWith(ORG, { name: "Acme", domain: "acme.com" });
		expect(o).toMatchObject({ kind: "result", result: { ok: true, status: 201, body: { linked: true, slug: "acme" } } });
	});

	it("400s a missing name or domain before touching the DB", async () => {
		const o = await dispatchTool("create_vendor", { domain: "acme.com" }, service());
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 400 } });
		expect(provisionVendorForOrg).not.toHaveBeenCalled();
	});

	it("passes through a provisioning failure status (409 already linked)", async () => {
		provisionVendorForOrg.mockResolvedValue({ ok: false, status: 409, error: "already linked" });
		const o = await dispatchTool("create_vendor", { name: "Acme", domain: "acme.com" }, service());
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 409 } });
	});

	it("403s a caller with no org context", async () => {
		const o = await dispatchTool("create_vendor", { name: "Acme", domain: "acme.com" }, service({ orgId: undefined }));
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 403 } });
		expect(provisionVendorForOrg).not.toHaveBeenCalled();
	});
});

describe("record_observed", () => {
	it("promotes the caller's OWN vendor's observed domain (resolves slug from vendorId)", async () => {
		promoteDomain.mockResolvedValue({ ok: true, slug: "des-ai", name: "Des AI", domain: "des-ai.com" });
		const o = await dispatchTool("record_observed", { domain: "des-ai.com" }, service({ vendorId: "v1" }));
		expect(promoteDomain).toHaveBeenCalledWith("acme", "des-ai.com"); // slug came from the DB lookup, not the args
		expect(o).toMatchObject({ kind: "result", result: { ok: true, status: 201 } });
	});

	it("maps a promote failure to its status (not_observed -> 422)", async () => {
		promoteDomain.mockResolvedValue({ ok: false, reason: "not_observed", detail: "never seen" });
		const o = await dispatchTool("record_observed", { domain: "nope.com" }, service({ vendorId: "v1" }));
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 422 } });
	});

	it("400s a missing domain", async () => {
		const o = await dispatchTool("record_observed", {}, service({ vendorId: "v1" }));
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 400 } });
		expect(promoteDomain).not.toHaveBeenCalled();
	});

	it("500s a vendor:write principal that carries no vendor (pre-vendor service call)", async () => {
		const o = await dispatchTool("record_observed", { domain: "des-ai.com" }, service({ vendorId: null }));
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 500 } });
	});
});
