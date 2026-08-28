import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionVendorForOrg } from "./provision";
import type { VendorFixture } from "@/lib/fixtures/vendors";

const insert = vi.fn<(row: Record<string, unknown>) => Promise<{ error: { code?: string } | null }>>();
const dbClient = vi.fn<() => unknown>();
vi.mock("@/lib/db/client", () => ({ dbClient: () => dbClient() }));

const findVendorByOrg = vi.fn<(orgId: string) => Promise<VendorFixture | undefined>>();
vi.mock("@/lib/fixtures/vendors", () => ({ findVendorByOrg: (o: string) => findVendorByOrg(o) }));

const ORG = "11111111-1111-1111-1111-111111111111";

function db() {
	return { from: () => ({ insert }) };
}
function existing(): VendorFixture {
	return { id: "v", slug: "v", name: "V", domain: "v.com", category: "c", key: "k", domainVerified: true, customers: [] };
}

beforeEach(() => {
	insert.mockReset();
	dbClient.mockReset().mockReturnValue(db());
	findVendorByOrg.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("provisionVendorForOrg", () => {
	it("500s when storage is unconfigured", async () => {
		dbClient.mockReturnValue(null);
		const r = await provisionVendorForOrg(ORG, { name: "Acme", domain: "acme.com" });
		expect(r).toMatchObject({ ok: false, status: 500 });
	});

	it("400s an unusable domain", async () => {
		const r = await provisionVendorForOrg(ORG, { name: "Acme", domain: "not a url" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
		expect(insert).not.toHaveBeenCalled();
	});

	it("400s a name with no slug characters", async () => {
		const r = await provisionVendorForOrg(ORG, { name: "!!!", domain: "acme.com" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});

	it("409s an org that already has a vendor, without inserting", async () => {
		findVendorByOrg.mockResolvedValue(existing());
		const r = await provisionVendorForOrg(ORG, { name: "Acme", domain: "acme.com" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(409);
		expect(insert).not.toHaveBeenCalled();
	});

	it("inserts with letterstory_org_id + default category and returns the vendor", async () => {
		insert.mockResolvedValue({ error: null });
		const r = await provisionVendorForOrg(ORG, { name: "Acme Corp", domain: "https://Acme.com/path" });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.slug).toBe("acme-corp");
			expect(r.domain).toBe("acme.com"); // normalized
		}
		const row = insert.mock.calls[0][0];
		expect(row).toMatchObject({ letterstory_org_id: ORG, slug: "acme-corp", domain: "acme.com", category: "software" });
		expect(typeof row.key).toBe("string");
	});

	it("retries once on a slug conflict, then succeeds", async () => {
		insert.mockResolvedValueOnce({ error: { code: "23505" } }).mockResolvedValueOnce({ error: null });
		const r = await provisionVendorForOrg(ORG, { name: "Acme", domain: "acme.com" });
		expect(r.ok).toBe(true);
		expect(insert).toHaveBeenCalledTimes(2);
		if (r.ok) expect(r.slug).toMatch(/^acme-[0-9a-f]{4}$/);
	});

	it("409s when the conflict persists after the retry (org already linked)", async () => {
		insert.mockResolvedValue({ error: { code: "23505" } });
		const r = await provisionVendorForOrg(ORG, { name: "Acme", domain: "acme.com" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(409);
		expect(insert).toHaveBeenCalledTimes(2);
	});
});
