import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLetterstoryCaller, resolveVendorForOrg } from "./vendor-access";
import type { VendorFixture } from "@/lib/fixtures/vendors";

const findVendorByOrg = vi.fn<(orgId: string) => Promise<VendorFixture | undefined>>();
vi.mock("@/lib/fixtures/vendors", () => ({
	findVendorByOrg: (orgId: string) => findVendorByOrg(orgId),
}));

const SECRET = "s3cr3t-shared-with-letterstory";
const ORG = "11111111-1111-1111-1111-111111111111";

let saved: string | undefined;

function req(auth?: string): Request {
	return new Request("https://app.letterprove.com/api/vendor/thing", {
		headers: auth ? { authorization: auth } : {},
	});
}

function vendor(): VendorFixture {
	return {
		id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		slug: "vantage",
		name: "Vantage",
		domain: "vantage.example",
		category: "customer data platforms",
		key: "lp_live_vantage_9f2c",
		domainVerified: true,
		proofsPublishedAt: "2026-01-01T00:00:00.000Z",
		customers: [],
	};
}

beforeEach(() => {
	saved = process.env.LETTERSTORY_API_SECRET;
	process.env.LETTERSTORY_API_SECRET = SECRET;
	findVendorByOrg.mockReset();
});
afterEach(() => {
	if (saved === undefined) delete process.env.LETTERSTORY_API_SECRET;
	else process.env.LETTERSTORY_API_SECRET = saved;
	vi.clearAllMocks();
});

describe("isLetterstoryCaller", () => {
	it("accepts the exact shared secret as Bearer", () => {
		expect(isLetterstoryCaller(req(`Bearer ${SECRET}`))).toBe(true);
	});
	it("rejects a wrong, absent, or non-Bearer secret", () => {
		expect(isLetterstoryCaller(req(`Bearer wrong`))).toBe(false);
		expect(isLetterstoryCaller(req())).toBe(false);
		expect(isLetterstoryCaller(req(`Basic ${SECRET}`))).toBe(false);
	});
	it("fails closed when the secret is unconfigured", () => {
		delete process.env.LETTERSTORY_API_SECRET;
		expect(isLetterstoryCaller(req(`Bearer ${SECRET}`))).toBe(false);
	});
	it("does not admit a secret that only shares a prefix (length-safe)", () => {
		expect(isLetterstoryCaller(req(`Bearer ${SECRET}-extra`))).toBe(false);
		expect(isLetterstoryCaller(req(`Bearer ${SECRET.slice(0, -1)}`))).toBe(false);
	});
});

describe("resolveVendorForOrg", () => {
	it("401s a caller without the service secret, without resolving anything", async () => {
		const r = await resolveVendorForOrg(req(), ORG);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.response.status).toBe(401);
		expect(findVendorByOrg).not.toHaveBeenCalled();
	});

	it("400s a missing org id", async () => {
		const r = await resolveVendorForOrg(req(`Bearer ${SECRET}`), "");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.response.status).toBe(400);
		expect(findVendorByOrg).not.toHaveBeenCalled();
	});

	it("404s an org that has no vendor yet", async () => {
		findVendorByOrg.mockResolvedValue(undefined);
		const r = await resolveVendorForOrg(req(`Bearer ${SECRET}`), ORG);
		expect(findVendorByOrg).toHaveBeenCalledWith(ORG);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.response.status).toBe(404);
	});

	it("resolves the trusted org to its vendor on a valid service call", async () => {
		findVendorByOrg.mockResolvedValue(vendor());
		const r = await resolveVendorForOrg(req(`Bearer ${SECRET}`), ORG);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.vendor.slug).toBe("vantage");
	});
});
