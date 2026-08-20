import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/telemetry/health", () => ({ checkCollectorHealth: vi.fn() }));
vi.mock("@/lib/alerts/notify", () => ({ sendAlert: vi.fn() }));

function request(auth?: string): Request {
	return new Request("https://app.letterprove.com/api/cron/collector-health", {
		headers: auth ? { authorization: auth } : {},
	});
}

describe("GET /api/cron/collector-health", () => {
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
		const { GET } = await import("./route");

		const res = await GET(request("Bearer whatever"));

		expect(res.status).toBe(401);
	});

	it("rejects a request with the wrong bearer token", async () => {
		const { GET } = await import("./route");

		const res = await GET(request("Bearer nope"));

		expect(res.status).toBe(401);
	});

	it("returns 200 and does not alert when the health check passes", async () => {
		const { checkCollectorHealth } = await import("@/lib/telemetry/health");
		const { sendAlert } = await import("@/lib/alerts/notify");
		vi.mocked(checkCollectorHealth).mockResolvedValue({ ok: true, detail: "insert + cleanup succeeded" });
		const { GET } = await import("./route");

		const res = await GET(request("Bearer test-secret"));
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toEqual({ ok: true, detail: "insert + cleanup succeeded" });
		expect(sendAlert).not.toHaveBeenCalled();
	});

	it("returns 500 and pages via sendAlert when the health check fails", async () => {
		const { checkCollectorHealth } = await import("@/lib/telemetry/health");
		const { sendAlert } = await import("@/lib/alerts/notify");
		vi.mocked(checkCollectorHealth).mockResolvedValue({ ok: false, detail: "insert failed: boom" });
		const { GET } = await import("./route");

		const res = await GET(request("Bearer test-secret"));
		const body = await res.json();

		expect(res.status).toBe(500);
		expect(body).toEqual({ ok: false, detail: "insert failed: boom" });
		expect(sendAlert).toHaveBeenCalledWith("collector health check failed", "insert failed: boom");
	});

	it("alerts instead of crashing when checkCollectorHealth itself throws", async () => {
		const { checkCollectorHealth } = await import("@/lib/telemetry/health");
		const { sendAlert } = await import("@/lib/alerts/notify");
		vi.mocked(checkCollectorHealth).mockRejectedValue(new Error("unexpected"));
		const { GET } = await import("./route");

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledWith("collector health check failed", expect.stringContaining("unexpected"));
	});
});
