import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/rollup/sessions", () => ({ rollupHotEvents: vi.fn() }));
vi.mock("@/lib/alerts/notify", () => ({ sendAlert: vi.fn() }));

function request(auth?: string): Request {
	return new Request("https://app.letterprove.com/api/cron/rollup", {
		headers: auth ? { authorization: auth } : {},
	});
}

async function mocks() {
	return {
		rollupHotEvents: vi.mocked((await import("@/rollup/sessions")).rollupHotEvents),
		sendAlert: vi.mocked((await import("@/lib/alerts/notify")).sendAlert),
		GET: (await import("./route")).GET,
	};
}

describe("GET /api/cron/rollup", () => {
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
		const { GET, rollupHotEvents } = await mocks();

		expect((await GET(request("Bearer whatever"))).status).toBe(401);
		expect(rollupHotEvents).not.toHaveBeenCalled();
	});

	it("rejects a request with the wrong bearer token", async () => {
		const { GET } = await mocks();

		expect((await GET(request("Bearer nope"))).status).toBe(401);
	});

	it("returns 200 and alerts nobody on a healthy run", async () => {
		const { GET, rollupHotEvents, sendAlert } = await mocks();
		rollupHotEvents.mockResolvedValue({ ok: true });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(sendAlert).not.toHaveBeenCalled();
	});

	// The rollup is one set-based upsert across every vendor, so its failure
	// has exactly one blast radius and the alert names it.
	it("returns 500 and pages with the scope named when the rollup fails", async () => {
		const { GET, rollupHotEvents, sendAlert } = await mocks();
		rollupHotEvents.mockResolvedValue({ ok: false, detail: "rollup_hot_events_hourly: deadlock detected" });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ ok: false, detail: "rollup_hot_events_hourly: deadlock detected" });
		expect(sendAlert).toHaveBeenCalledWith(
			"hourly rollup failed (all vendors)",
			"rollup_hot_events_hourly: deadlock detected"
		);
	});

	// An unexpected throw was the one remaining path back to silence.
	it("alerts instead of crashing when the rollup itself throws", async () => {
		const { GET, rollupHotEvents, sendAlert } = await mocks();
		rollupHotEvents.mockRejectedValue(new Error("connection reset"));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledWith(
			"hourly rollup failed (all vendors)",
			expect.stringContaining("connection reset")
		);
	});
});
