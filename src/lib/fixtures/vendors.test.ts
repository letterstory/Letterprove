import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

import { dbClient } from "@/lib/db/client";
import { allVendors, findVendor, findVendorByKey } from "./vendors";

/**
 * These exist because of a real bug: all three lookups rebuilt the vendor row
 * as a hand-written literal, and every one of them forgot `domain_verified_at`
 * when it was added. Nothing failed — `domainVerified` just became false
 * everywhere, which silently capped every vendor at tier 0 including verified
 * ones, and would have refused all collection once the collector started
 * gating on it. A dropped field is invisible; that is what makes it worth a
 * test rather than a careful reading.
 */

const ROW = {
	id: "v1",
	slug: "acme",
	name: "Acme",
	domain: "acme.com",
	category: "cdp",
	key: "lp_live_acme",
	domain_verified_at: "2026-08-20T00:00:00.000Z",
};

function mockDb(row: Record<string, unknown> | null) {
	const customers = { data: [], error: null };
	const client = {
		from: vi.fn((table: string) => {
			if (table === "vendor_customers") {
				return { select: vi.fn(() => ({ eq: vi.fn().mockResolvedValue(customers) })) };
			}
			return {
				select: vi.fn(() => ({
					eq: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: row }) })),
					// allVendors selects without a filter
					then: undefined,
				})),
			};
		}),
	};
	return client;
}

beforeEach(() => vi.clearAllMocks());

describe("vendor lookups carry verification state", () => {
	it("findVendorByKey reports a verified vendor as verified", async () => {
		// The collector's path. If this is false for a verified vendor, every
		// event that vendor sends is refused.
		vi.mocked(dbClient).mockReturnValue(mockDb(ROW) as never);
		const vendor = await findVendorByKey("lp_live_acme");
		expect(vendor?.domainVerified).toBe(true);
	});

	it("findVendorByKey reports an unverified vendor as unverified", async () => {
		vi.mocked(dbClient).mockReturnValue(mockDb({ ...ROW, domain_verified_at: null }) as never);
		const vendor = await findVendorByKey("lp_live_acme");
		expect(vendor?.domainVerified).toBe(false);
	});

	it("findVendor reports verification too", async () => {
		// The publishing path. If this is false for a verified vendor, its
		// proofs stay at tier 0 however much was legitimately observed.
		vi.mocked(dbClient).mockReturnValue(mockDb(ROW) as never);
		const vendor = await findVendor("acme");
		expect(vendor?.domainVerified).toBe(true);
	});

	it("returns undefined rather than a half-built fixture when the row is gone", async () => {
		vi.mocked(dbClient).mockReturnValue(mockDb(null) as never);
		expect(await findVendorByKey("nope")).toBeUndefined();
		expect(await findVendor("nope")).toBeUndefined();
	});

	it("returns nothing at all when there is no datastore", async () => {
		vi.mocked(dbClient).mockReturnValue(null as never);
		expect(await findVendorByKey("lp_live_acme")).toBeUndefined();
		expect(await allVendors()).toEqual([]);
	});
});
