import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stripe/sync-all", () => ({ syncAllVendorPayments: vi.fn() }));
vi.mock("@/lib/alerts/notify", () => ({ sendAlert: vi.fn() }));

function request(auth?: string): Request {
	return new Request("https://app.letterprove.com/api/cron/stripe-sync", {
		headers: auth ? { authorization: auth } : {},
	});
}

async function mocks() {
	return {
		syncAllVendorPayments: vi.mocked((await import("@/lib/stripe/sync-all")).syncAllVendorPayments),
		sendAlert: vi.mocked((await import("@/lib/alerts/notify")).sendAlert),
		GET: (await import("./route")).GET,
	};
}

function run(over: Record<string, unknown> = {}) {
	return { ok: true, attempted: 1, synced: 1, testMode: 0, truncated: [], failures: [], ...over } as never;
}

describe("GET /api/cron/stripe-sync", () => {
	const originalSecret = process.env.CRON_SECRET;

	beforeEach(() => {
		process.env.CRON_SECRET = "test-secret";
	});

	afterEach(() => {
		if (originalSecret === undefined) delete process.env.CRON_SECRET;
		else process.env.CRON_SECRET = originalSecret;
		vi.clearAllMocks();
	});

	it("fails closed with 401 when CRON_SECRET is unset", async () => {
		delete process.env.CRON_SECRET;
		const { GET, syncAllVendorPayments } = await mocks();

		const res = await GET(request("Bearer whatever"));

		expect(res.status).toBe(401);
		expect(syncAllVendorPayments).not.toHaveBeenCalled();
	});

	it("rejects a request with the wrong bearer token", async () => {
		const { GET, syncAllVendorPayments } = await mocks();

		expect((await GET(request("Bearer nope"))).status).toBe(401);
		expect(syncAllVendorPayments).not.toHaveBeenCalled();
	});

	it("returns 200 and alerts nobody on a healthy run", async () => {
		const { GET, syncAllVendorPayments, sendAlert } = await mocks();
		syncAllVendorPayments.mockResolvedValue(run({ attempted: 2, synced: 2 }));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, attempted: 2, synced: 2 });
		expect(sendAlert).not.toHaveBeenCalled();
	});

	// Stated outright in the brief, and the alert-fatigue trap this cron could
	// most easily walk into: the only key ever connected in production is a test
	// key, so an implementation that paged on it would page every hour forever.
	it("does not alert about a vendor whose test-mode key stored nothing", async () => {
		const { GET, syncAllVendorPayments, sendAlert } = await mocks();
		syncAllVendorPayments.mockResolvedValue(run({ attempted: 1, synced: 0, testMode: 1 }));

		expect((await GET(request("Bearer test-secret"))).status).toBe(200);
		expect(sendAlert).not.toHaveBeenCalled();
	});

	it("alerts once per failing vendor, naming each one", async () => {
		const { GET, syncAllVendorPayments, sendAlert } = await mocks();
		syncAllVendorPayments.mockResolvedValue(
			run({
				ok: false,
				attempted: 3,
				synced: 1,
				failures: [
					{ vendorSlug: "acme", detail: "Expired API Key provided." },
					{ vendorSlug: "globex", detail: "Couldn't reach Stripe." },
				],
			}),
		);

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledTimes(2);
		expect(sendAlert).toHaveBeenCalledWith("stripe sync failed: acme", "Expired API Key provided.");
		expect(sendAlert).toHaveBeenCalledWith("stripe sync failed: globex", "Couldn't reach Stripe.");
	});

	// Naming a vendor here would point an investigation at the wrong place:
	// nothing was synced and no vendor is at fault.
	it("alerts on its own subject when the run could not start", async () => {
		const { GET, syncAllVendorPayments, sendAlert } = await mocks();
		syncAllVendorPayments.mockResolvedValue(run({ ok: false, attempted: 0, synced: 0, detail: "no datastore configured" }));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledTimes(1);
		expect(sendAlert).toHaveBeenCalledWith("stripe sync could not start", "no datastore configured");
	});

	it("turns an unexpected throw into an alert rather than an unhandled rejection", async () => {
		const { GET, syncAllVendorPayments, sendAlert } = await mocks();
		syncAllVendorPayments.mockRejectedValue(new Error("vendors table unreachable"));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledWith(
			"stripe sync could not start",
			expect.stringContaining("vendors table unreachable"),
		);
	});

	// A prefix of the truth is indistinguishable downstream from the whole
	// truth, so it pages, but it did not fail and must not report as failed.
	it("alerts on a truncated vendor while still reporting the run as healthy", async () => {
		const { GET, syncAllVendorPayments, sendAlert } = await mocks();
		syncAllVendorPayments.mockResolvedValue(run({ truncated: ["acme"] }));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(200);
		expect(sendAlert).toHaveBeenCalledWith("stripe sync truncated: acme", expect.stringContaining("incomplete"));
	});
});
