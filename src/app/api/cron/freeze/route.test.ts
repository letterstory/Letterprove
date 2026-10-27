import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/rollup/freeze-aggregates", () => ({ freezeAggregates: vi.fn() }));
vi.mock("@/lib/alerts/notify", () => ({ sendAlert: vi.fn() }));

function request(auth?: string): Request {
	return new Request("https://app.letterprove.com/api/cron/freeze", {
		headers: auth ? { authorization: auth } : {},
	});
}

async function mocks() {
	return {
		freezeAggregates: vi.mocked((await import("@/rollup/freeze-aggregates")).freezeAggregates),
		sendAlert: vi.mocked((await import("@/lib/alerts/notify")).sendAlert),
		GET: (await import("./route")).GET,
	};
}

// One half since 2026-10-13: the vendor attestations. Per-customer snapshots
// were retired (README decision 30) and are no longer frozen.
describe("GET /api/cron/freeze", () => {
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
		const { GET, freezeAggregates } = await mocks();

		const res = await GET(request("Bearer whatever"));

		expect(res.status).toBe(401);
		expect(freezeAggregates).not.toHaveBeenCalled();
	});

	it("rejects a request with the wrong bearer token", async () => {
		const { GET } = await mocks();

		expect((await GET(request("Bearer nope"))).status).toBe(401);
	});

	it("returns 200 and alerts nobody on a healthy run", async () => {
		const { GET, freezeAggregates, sendAlert } = await mocks();
		freezeAggregates.mockResolvedValue({ ok: true, frozen: 5 });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, aggregates: { ok: true, frozen: 5 } });
		expect(sendAlert).not.toHaveBeenCalled();
	});

	it("does not alert on a healthy run that skipped vendors", async () => {
		const { GET, freezeAggregates, sendAlert } = await mocks();
		freezeAggregates.mockResolvedValue({ ok: true, frozen: 4, skipped: ["evident"] });

		expect((await GET(request("Bearer test-secret"))).status).toBe(200);
		expect(sendAlert).not.toHaveBeenCalled();
	});

	it("alerts with the detail and how far it got", async () => {
		const { GET, freezeAggregates, sendAlert } = await mocks();
		freezeAggregates.mockResolvedValue({ ok: false, frozen: 2, detail: "lettertrace: insert boom" });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledTimes(1);
		expect(sendAlert).toHaveBeenCalledWith(
			"hourly freeze failed: vendor attestations",
			expect.stringContaining("lettertrace: insert boom"),
		);
		expect(sendAlert).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("froze 2"));
	});

	it("turns a throw into a named alert rather than an unhandled rejection", async () => {
		const { GET, freezeAggregates, sendAlert } = await mocks();
		freezeAggregates.mockRejectedValue(new Error("vendors table unreachable"));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledWith(
			"hourly freeze failed: vendor attestations",
			expect.stringContaining("threw: vendors table unreachable"),
		);
	});
});
