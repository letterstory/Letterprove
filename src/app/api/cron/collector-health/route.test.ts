import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/telemetry/health", () => ({ checkCollectorHealth: vi.fn() }));
vi.mock("@/rollup/freshness", () => ({ checkPublicationFreshness: vi.fn() }));
vi.mock("@/lib/alerts/notify", () => ({ sendAlert: vi.fn() }));

function request(auth?: string): Request {
	return new Request("https://app.letterprove.com/api/cron/collector-health", {
		headers: auth ? { authorization: auth } : {},
	});
}

/** The default for tests that are not about freshness: the record is current. */
const FRESH = {
	ok: true,
	checks: [
		{
			scope: "per-customer snapshots (/attest/{vendor}/{customer})",
			ok: true,
			detail: "newest frozen hour is 0h behind",
		},
		{ scope: "vendor aggregates (/attest/{vendor})", ok: true, detail: "newest frozen hour is 0h behind" },
	],
};

async function mocks() {
	return {
		checkCollectorHealth: vi.mocked((await import("@/lib/telemetry/health")).checkCollectorHealth),
		checkPublicationFreshness: vi.mocked((await import("@/rollup/freshness")).checkPublicationFreshness),
		sendAlert: vi.mocked((await import("@/lib/alerts/notify")).sendAlert),
		GET: (await import("./route")).GET,
	};
}

describe("GET /api/cron/collector-health", () => {
	const originalSecret = process.env.CRON_SECRET;

	beforeEach(async () => {
		process.env.CRON_SECRET = "test-secret";
		const { checkCollectorHealth, checkPublicationFreshness } = await mocks();
		checkCollectorHealth.mockResolvedValue({ ok: true, detail: "insert + cleanup succeeded" });
		checkPublicationFreshness.mockResolvedValue(FRESH);
	});

	afterEach(() => {
		if (originalSecret === undefined) delete process.env.CRON_SECRET;
		else process.env.CRON_SECRET = originalSecret;
		vi.clearAllMocks();
	});

	it("fails closed with 401 when CRON_SECRET is unset", async () => {
		delete process.env.CRON_SECRET;
		const { GET } = await mocks();

		const res = await GET(request("Bearer whatever"));

		expect(res.status).toBe(401);
	});

	it("rejects a request with the wrong bearer token", async () => {
		const { GET } = await mocks();

		const res = await GET(request("Bearer nope"));

		expect(res.status).toBe(401);
	});

	it("returns 200 and does not alert when both checks pass", async () => {
		const { GET, sendAlert } = await mocks();

		const res = await GET(request("Bearer test-secret"));
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.ok).toBe(true);
		expect(body.collector).toEqual({ ok: true, detail: "insert + cleanup succeeded" });
		expect(sendAlert).not.toHaveBeenCalled();
	});

	it("returns 500 and pages via sendAlert when the health check fails", async () => {
		const { GET, checkCollectorHealth, sendAlert } = await mocks();
		checkCollectorHealth.mockResolvedValue({ ok: false, detail: "insert failed: boom" });

		const res = await GET(request("Bearer test-secret"));
		const body = await res.json();

		expect(res.status).toBe(500);
		expect(body.collector).toEqual({ ok: false, detail: "insert failed: boom" });
		expect(sendAlert).toHaveBeenCalledWith("collector health check failed", "insert failed: boom");
	});

	it("alerts instead of crashing when checkCollectorHealth itself throws", async () => {
		const { GET, checkCollectorHealth, sendAlert } = await mocks();
		checkCollectorHealth.mockRejectedValue(new Error("unexpected"));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledWith("collector health check failed", expect.stringContaining("unexpected"));
	});

	// The second failure this route exists to catch: the freeze stopped, or
	// stopped freezing anything, and nothing threw. The collector is perfectly
	// healthy while every served attestation goes on claiming to be current.
	it("pages when the published record is stale even though nothing failed", async () => {
		const { GET, checkPublicationFreshness, sendAlert } = await mocks();
		checkPublicationFreshness.mockResolvedValue({
			ok: false,
			checks: [
				{
					scope: "per-customer snapshots (/attest/{vendor}/{customer})",
					ok: false,
					detail: "newest frozen hour is 5h behind",
				},
				{ scope: "vendor aggregates (/attest/{vendor})", ok: true, detail: "newest frozen hour is 0h behind" },
			],
		});

		const res = await GET(request("Bearer test-secret"));
		const body = await res.json();

		expect(res.status).toBe(500);
		expect(body.ok).toBe(false);
		// The collector half is still reported honestly: this is not its outage.
		expect(body.collector.ok).toBe(true);
		expect(sendAlert).toHaveBeenCalledTimes(1);
		expect(sendAlert).toHaveBeenCalledWith(
			"published record freshness: per-customer snapshots (/attest/{vendor}/{customer})",
			"newest frozen hour is 5h behind"
		);
	});

	it("alerts instead of crashing when the freshness check itself throws", async () => {
		const { GET, checkPublicationFreshness, sendAlert } = await mocks();
		checkPublicationFreshness.mockRejectedValue(new Error("query timed out"));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledWith(
			"published record freshness: all published proofs",
			expect.stringContaining("query timed out")
		);
	});

	it("pages separately for each stale half so the blast radius is nameable", async () => {
		const { GET, checkPublicationFreshness, sendAlert } = await mocks();
		checkPublicationFreshness.mockResolvedValue({
			ok: false,
			checks: [
				{
					scope: "per-customer snapshots (/attest/{vendor}/{customer})",
					ok: false,
					detail: "newest frozen hour is 5h behind",
				},
				{ scope: "vendor aggregates (/attest/{vendor})", ok: false, detail: "newest frozen hour is 5h behind" },
			],
		});

		await GET(request("Bearer test-secret"));

		expect(sendAlert).toHaveBeenCalledTimes(2);
	});
});
