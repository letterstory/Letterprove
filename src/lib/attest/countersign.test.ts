import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countersign } from "./countersign";
import type { AttestationBody } from "./types";

// Vendor/customer identity is DB-backed now (supabase/migrations/
// 20260814230000_vendor_accounts.sql). This suite exercises the RPC/local
// signing paths, not the database, so mock the lookup at the module
// boundary, holding it to the same two vendors/customers the static fixture
// used to ship.
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/fixtures/vendors")>();
	const VENDORS: import("@/lib/fixtures/vendors").VendorFixture[] = [
		{
			id: "00000000-0000-0000-0000-000000000001",
			slug: "vantage",
			name: "Vantage",
			domain: "vantage.example",
			category: "customer data platforms",
			key: "lp_live_vantage_9f2c", domainVerified: true,
			customers: [
				{ slug: "acme-corp", name: "Acme Corp", domain: "acme-corp.example", since: "2023-03", tier: 2, verified: true, features: ["sso", "api", "analytics"], consent: "named" },
				{ slug: "northwind", name: "Northwind", domain: "northwind.example", since: "2024-08", tier: 2, verified: true, features: ["sso", "api", "analytics", "sla"], consent: "anonymous" },
				{ slug: "globex", name: "Globex", domain: "globex.example", since: "2022-11", tier: 1, verified: false, features: ["sso", "audit_log", "api"] },
			],
		},
		{ id: "00000000-0000-0000-0000-000000000001", slug: "lettertrace", name: "Lettertrace", domain: "lettertrace.com", category: "AI brand monitoring", key: "lp_live_lettertrace_5747b5e0f521", domainVerified: true, customers: [] },
	];
	return {
		...original,
		allVendors: async () => VENDORS,
		findVendor: async (slug: string) => VENDORS.find((v) => v.slug === slug),
		findVendorByKey: async (key: string) => VENDORS.find((v) => v.key === key),
	};
});

const ENV_KEYS = ["LETTERSTORY_COUNTERSIGN_URL", "LETTERSTORY_COUNTERSIGN_SECRET"] as const;
let saved: Record<string, string | undefined>;

function body(overrides: Partial<AttestationBody> = {}): AttestationBody {
	return {
		vendor: "vantage",
		customer: "acme-corp",
		customer_name: "Acme Corp",
		verified: true,
		tier: 2,
		since: "2023-03",
		features: ["sso", "api"],
		sessions_30d: 42,
		seats_active: 0,
		observed_through: "2026-08-13T00:00:00.000Z",
		published_at: "2026-08-13T00:00:00.000Z",
		ttl: 3600,
		prev_hash: "0".repeat(64),
		method: "https://example.com/method",
		...overrides,
	};
}

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.unstubAllGlobals();
});

describe("countersign — RPC path", () => {
	it("does not call fetch at all when the RPC isn't configured (dev signing instead)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await countersign(body());
		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.key_id).toMatch(/^dev-insecure-/);
	});

	it("throws when the RPC is configured for a vendor/customer not in the fixtures", async () => {
		process.env.LETTERSTORY_COUNTERSIGN_URL = "https://letterstory.example/api/letterprove/countersign";
		process.env.LETTERSTORY_COUNTERSIGN_SECRET = "shh";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(countersign(body({ vendor: "nope", customer: "nope" }))).rejects.toThrow(/unknown vendor\/customer/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("POSTs the body plus fraud features, with the bearer secret, and returns the RPC's signature on success", async () => {
		process.env.LETTERSTORY_COUNTERSIGN_URL = "https://letterstory.example/api/letterprove/countersign";
		process.env.LETTERSTORY_COUNTERSIGN_SECRET = "shh";
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ signature: "sig-bytes", key_id: "lp-real-1" }), { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await countersign(body());
		expect(result).toEqual({ signature: "sig-bytes", key_id: "lp-real-1" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://letterstory.example/api/letterprove/countersign");
		expect(init.method).toBe("POST");
		expect(init.headers["authorization"]).toBe("Bearer shh");
		const sent = JSON.parse(init.body);
		expect(sent.body.vendor).toBe("vantage");
		expect(sent.fraud_features.vendor).toBe("vantage");
		expect(sent.fraud_features.customer).toBe("acme-corp");
		expect(sent.fraud_features.schema_version).toBe(1);
	});

	it("throws on a fraud-check refusal (403) rather than falling back to local signing", async () => {
		process.env.LETTERSTORY_COUNTERSIGN_URL = "https://letterstory.example/api/letterprove/countersign";
		process.env.LETTERSTORY_COUNTERSIGN_SECRET = "shh";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(JSON.stringify({ rejected: true, reason: "burst pattern" }), { status: 403 }))
		);

		await expect(countersign(body())).rejects.toThrow(/burst pattern/);
	});

	it("throws on any other non-2xx response", async () => {
		process.env.LETTERSTORY_COUNTERSIGN_URL = "https://letterstory.example/api/letterprove/countersign";
		process.env.LETTERSTORY_COUNTERSIGN_SECRET = "shh";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not configured" }), { status: 503 })));

		await expect(countersign(body())).rejects.toThrow(/503/);
	});

	it("throws on a malformed 200 response", async () => {
		process.env.LETTERSTORY_COUNTERSIGN_URL = "https://letterstory.example/api/letterprove/countersign";
		process.env.LETTERSTORY_COUNTERSIGN_SECRET = "shh";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

		await expect(countersign(body())).rejects.toThrow(/malformed/);
	});
});
