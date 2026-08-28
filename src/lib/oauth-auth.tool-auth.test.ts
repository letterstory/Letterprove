import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateToolRequest, LETTERSTORY_SERVICE_IDENTITY } from "./oauth-auth";
import type { VendorFixture } from "@/lib/fixtures/vendors";
import type { OAuthPrincipal } from "@/lib/oauth/core";

const findVendorByOrg = vi.fn<(orgId: string) => Promise<VendorFixture | undefined>>();
vi.mock("@/lib/fixtures/vendors", () => ({
	findVendorByOrg: (orgId: string) => findVendorByOrg(orgId),
}));

const resolveAccessToken = vi.fn<(token: string) => Promise<OAuthPrincipal | null>>();
vi.mock("@/lib/oauth/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/oauth/core")>();
	return { ...actual, resolveAccessToken: (t: string) => resolveAccessToken(t) };
});

const SECRET = "svc-secret";
const ORG = "11111111-1111-1111-1111-111111111111";
const VENDOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let saved: string | undefined;

function post(body: unknown, auth?: string): Request {
	return new Request("https://app.letterprove.com/api/v1/tools/get_status", {
		method: "POST",
		headers: auth ? { authorization: auth, "content-type": "application/json" } : { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function vendor(): VendorFixture {
	return { id: VENDOR_ID, slug: "v", name: "V", domain: "v.com", category: "c", key: "k", domainVerified: true, customers: [] };
}

beforeEach(() => {
	saved = process.env.LETTERSTORY_API_SECRET;
	process.env.LETTERSTORY_API_SECRET = SECRET;
	findVendorByOrg.mockReset();
	resolveAccessToken.mockReset();
});
afterEach(() => {
	if (saved === undefined) delete process.env.LETTERSTORY_API_SECRET;
	else process.env.LETTERSTORY_API_SECRET = saved;
	vi.clearAllMocks();
});

describe("authenticateToolRequest — Letterstory service door", () => {
	it("resolves org_id to a vendor-scoped principal (vendor:read+write, no staff)", async () => {
		findVendorByOrg.mockResolvedValue(vendor());
		const r = await authenticateToolRequest(post({ org_id: ORG }, `Bearer ${SECRET}`), { org_id: ORG });
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.principal.vendorId).toBe(VENDOR_ID);
			expect(r.principal.orgId).toBe(ORG);
			expect(r.principal.capabilities).toEqual(["vendor:read", "vendor:write"]);
			expect(r.principal.capabilities).not.toContain("staff:write");
			expect(r.principal.userId).toBe(LETTERSTORY_SERVICE_IDENTITY);
		}
	});

	it("keeps vendorId null but orgId set for a pre-vendor org (provisioning case)", async () => {
		findVendorByOrg.mockResolvedValue(undefined);
		const r = await authenticateToolRequest(post({ org_id: ORG }, `Bearer ${SECRET}`), { org_id: ORG });
		expect(r.success).toBe(true);
		if (r.success) {
			expect(r.principal.vendorId).toBeNull();
			expect(r.principal.orgId).toBe(ORG);
		}
	});

	it("attributes a trusted user_id when Letterstory sends one", async () => {
		findVendorByOrg.mockResolvedValue(vendor());
		const r = await authenticateToolRequest(post({ org_id: ORG, user_id: "user-9" }, `Bearer ${SECRET}`), { org_id: ORG, user_id: "user-9" });
		expect(r.success && r.principal.userId).toBe("user-9");
	});

	it("400s a service call with no org_id", async () => {
		const r = await authenticateToolRequest(post({}, `Bearer ${SECRET}`), {});
		expect(r.success).toBe(false);
		if (!r.success) expect(r.response.status).toBe(400);
		expect(findVendorByOrg).not.toHaveBeenCalled();
	});
});

describe("authenticateToolRequest — OAuth door (fallback)", () => {
	it("uses the bearer token when the service secret is absent", async () => {
		const principal: OAuthPrincipal = { tokenId: "t1", vendorId: VENDOR_ID, userId: "u1", capabilities: ["vendor:read"] };
		resolveAccessToken.mockResolvedValue(principal);
		const r = await authenticateToolRequest(post({}, "Bearer cli-token"), {});
		expect(resolveAccessToken).toHaveBeenCalledWith("cli-token");
		expect(r.success && r.principal.vendorId).toBe(VENDOR_ID);
		expect(findVendorByOrg).not.toHaveBeenCalled();
	});

	it("401s when neither door authenticates", async () => {
		const r = await authenticateToolRequest(post({}), {});
		expect(r.success).toBe(false);
		if (!r.success) expect(r.response.status).toBe(401);
	});
});
