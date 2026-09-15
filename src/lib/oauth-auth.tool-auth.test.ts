import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateToolRequest, LETTERSTORY_SERVICE_IDENTITY } from "./oauth-auth";
import type { VendorFixture } from "@/lib/fixtures/vendors";

const findVendorByOrg = vi.fn<(orgId: string) => Promise<VendorFixture | undefined>>();
vi.mock("@/lib/fixtures/vendors", () => ({
	findVendorByOrg: (orgId: string) => findVendorByOrg(orgId),
}));

const SECRET = "svc-secret";
const ORG = "11111111-1111-1111-1111-111111111111";
const VENDOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let saved: string | undefined;
let savedStaff: string | undefined;

function post(body: unknown, auth?: string): Request {
	return new Request("https://app.letterprove.com/api/v1/tools/get_status", {
		method: "POST",
		headers: auth ? { authorization: auth, "content-type": "application/json" } : { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function vendor(): VendorFixture {
	return { id: VENDOR_ID, slug: "v", name: "V", domain: "v.com", category: "c", key: "k", domainVerified: true, proofsPublishedAt: "2026-01-01T00:00:00.000Z", customers: [] };
}

beforeEach(() => {
	saved = process.env.LETTERSTORY_API_SECRET;
	savedStaff = process.env.STAFF_USER_IDS;
	// Nobody is staff unless a test says so — the fail-closed default.
	delete process.env.STAFF_USER_IDS;
	process.env.LETTERSTORY_API_SECRET = SECRET;
	findVendorByOrg.mockReset();
});
afterEach(() => {
	if (saved === undefined) delete process.env.LETTERSTORY_API_SECRET;
	else process.env.LETTERSTORY_API_SECRET = saved;
	if (savedStaff === undefined) delete process.env.STAFF_USER_IDS;
	else process.env.STAFF_USER_IDS = savedStaff;
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

describe("authenticateToolRequest — no OAuth fallback", () => {
	it("401s a bearer token that is not the service secret (the OAuth door is retired)", async () => {
		const r = await authenticateToolRequest(post({}, "Bearer cli-token"), {});
		expect(r.success).toBe(false);
		if (!r.success) expect(r.response.status).toBe(401);
		// It never tries to resolve the caller as a vendor — there is no org context.
		expect(findVendorByOrg).not.toHaveBeenCalled();
	});

	it("401s when no credential is presented at all", async () => {
		const r = await authenticateToolRequest(post({}), {});
		expect(r.success).toBe(false);
		if (!r.success) expect(r.response.status).toBe(401);
	});

	/*
	 * Cross-vendor capability, and the reason it is safe to grant over a seam
	 * that only proves "this is Letterstory's backend": the grant is not
	 * attached to the seam. It is attached to the acting human, and Letterprove
	 * — not Letterstory — decides who that may be.
	 */
	describe("staff capability", () => {
		const STAFF = "22222222-2222-2222-2222-222222222222";

		it("grants staff:* to an acting user this deployment named as staff", async () => {
			process.env.STAFF_USER_IDS = STAFF;
			findVendorByOrg.mockResolvedValue(vendor());

			const body = { org_id: ORG, user_id: STAFF };
			const r = await authenticateToolRequest(post(body, `Bearer ${SECRET}`), body);

			expect(r.success).toBe(true);
			if (!r.success) return;
			expect(r.principal.capabilities).toEqual(["vendor:read", "vendor:write", "staff:read", "staff:write"]);
			expect(r.principal.userId).toBe(STAFF);
		});

		it("withholds staff:* from an acting user who is not on the allowlist", async () => {
			process.env.STAFF_USER_IDS = STAFF;
			findVendorByOrg.mockResolvedValue(vendor());

			// A real customer, calling with the same valid service secret. The
			// secret proves the CALLER, never the person behind it.
			const body = { org_id: ORG, user_id: "99999999-9999-9999-9999-999999999999" };
			const r = await authenticateToolRequest(post(body, `Bearer ${SECRET}`), body);

			expect(r.success).toBe(true);
			if (!r.success) return;
			expect(r.principal.capabilities).toEqual(["vendor:read", "vendor:write"]);
		});

		it("grants nothing when the deployment has named no staff at all", async () => {
			delete process.env.STAFF_USER_IDS;
			findVendorByOrg.mockResolvedValue(vendor());

			const body = { org_id: ORG, user_id: STAFF };
			const r = await authenticateToolRequest(post(body, `Bearer ${SECRET}`), body);

			expect(r.success).toBe(true);
			if (!r.success) return;
			// Fails closed. An unconfigured deployment serves no staff surface,
			// rather than serving it to everyone.
			expect(r.principal.capabilities).not.toContain("staff:read");
		});

		it("never grants staff:* to a call that names no acting human", async () => {
			process.env.STAFF_USER_IDS = `${STAFF},${LETTERSTORY_SERVICE_IDENTITY}`;
			findVendorByOrg.mockResolvedValue(vendor());

			// The sentinel identity must not be allowlistable into staff: it
			// means "no human was named", and cross-vendor writes have to be
			// attributable to a person.
			const r = await authenticateToolRequest(post({ org_id: ORG }, `Bearer ${SECRET}`), { org_id: ORG });

			expect(r.success).toBe(true);
            if (!r.success) return;
			expect(r.principal.capabilities).not.toContain("staff:write");
		});
	});

});
