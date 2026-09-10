import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/rollup/freeze", () => ({ freezeSnapshots: vi.fn() }));
vi.mock("@/rollup/freeze-aggregates", () => ({ freezeAggregates: vi.fn() }));
vi.mock("@/lib/alerts/notify", () => ({ sendAlert: vi.fn() }));

function request(auth?: string): Request {
	return new Request("https://app.letterprove.com/api/cron/freeze", {
		headers: auth ? { authorization: auth } : {},
	});
}

async function mocks() {
	return {
		freezeSnapshots: vi.mocked((await import("@/rollup/freeze")).freezeSnapshots),
		freezeAggregates: vi.mocked((await import("@/rollup/freeze-aggregates")).freezeAggregates),
		sendAlert: vi.mocked((await import("@/lib/alerts/notify")).sendAlert),
		GET: (await import("./route")).GET,
	};
}

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
		const { GET, freezeSnapshots } = await mocks();

		const res = await GET(request("Bearer whatever"));

		expect(res.status).toBe(401);
		expect(freezeSnapshots).not.toHaveBeenCalled();
	});

	it("rejects a request with the wrong bearer token", async () => {
		const { GET } = await mocks();

		expect((await GET(request("Bearer nope"))).status).toBe(401);
	});

	it("returns 200 and alerts nobody on a healthy run", async () => {
		const { GET, freezeSnapshots, freezeAggregates, sendAlert } = await mocks();
		freezeSnapshots.mockResolvedValue({ ok: true, frozen: 3 });
		freezeAggregates.mockResolvedValue({ ok: true, frozen: 1 });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			snapshots: { ok: true, frozen: 3 },
			aggregates: { ok: true, frozen: 1 },
		});
		expect(sendAlert).not.toHaveBeenCalled();
	});

	// A skip is a designed-for state, not a failure: the chain links by
	// prev_hash rather than by contiguous hours. Paging on one would train
	// people to ignore the channel. Persistent skipping is caught instead by
	// the staleness watchdog, which measures the record rather than the run.
	it("does not alert on a healthy run that skipped subjects", async () => {
		const { GET, freezeSnapshots, freezeAggregates, sendAlert } = await mocks();
		freezeSnapshots.mockResolvedValue({ ok: true, frozen: 2, skipped: ["vantage/globex"] });
		freezeAggregates.mockResolvedValue({ ok: true, frozen: 1 });

		expect((await GET(request("Bearer test-secret"))).status).toBe(200);
		expect(sendAlert).not.toHaveBeenCalled();
	});

	// The half that failed has to be nameable from the Slack line alone: the
	// aggregate publishing while snapshots die is a different investigation
	// from the reverse.
	it("alerts for only the failing half and names it", async () => {
		const { GET, freezeSnapshots, freezeAggregates, sendAlert } = await mocks();
		freezeSnapshots.mockResolvedValue({ ok: false, frozen: 2, detail: "vantage/globex: upsert boom" });
		freezeAggregates.mockResolvedValue({ ok: true, frozen: 1 });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledTimes(1);
		expect(sendAlert).toHaveBeenCalledWith(
			"hourly freeze failed: per-customer snapshots",
			expect.stringContaining("vantage/globex: upsert boom")
		);
		// How far it got is blast radius too: dying at vendor 2 is a different
		// morning from dying at vendor 40.
		expect(sendAlert).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("froze 2 before failing"));
	});

	it("alerts once per half when both fail", async () => {
		const { GET, freezeSnapshots, freezeAggregates, sendAlert } = await mocks();
		freezeSnapshots.mockResolvedValue({ ok: false, frozen: 0, detail: "no datastore configured" });
		freezeAggregates.mockResolvedValue({ ok: false, frozen: 0, detail: "no datastore configured" });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledTimes(2);
		expect(sendAlert.mock.calls.map((call) => call[0])).toEqual([
			"hourly freeze failed: per-customer snapshots",
			"hourly freeze failed: vendor aggregates",
		]);
	});

	// A throw used to escape as an unhandled rejection with no alert, and under
	// Promise.all it also discarded the other half's result.
	it("turns a throwing half into a named alert and still reports the other half", async () => {
		const { GET, freezeSnapshots, freezeAggregates, sendAlert } = await mocks();
		freezeSnapshots.mockRejectedValue(new Error("vendors table unreachable"));
		freezeAggregates.mockResolvedValue({ ok: true, frozen: 1 });

		const res = await GET(request("Bearer test-secret"));
		const body = await res.json();

		expect(res.status).toBe(500);
		expect(body.aggregates).toEqual({ ok: true, frozen: 1 });
		expect(sendAlert).toHaveBeenCalledWith(
			"hourly freeze failed: per-customer snapshots",
			expect.stringContaining("vendors table unreachable")
		);
	});

	it("names the skipped subjects in the alert so the blast radius is readable", async () => {
		const { GET, freezeSnapshots, freezeAggregates, sendAlert } = await mocks();
		freezeSnapshots.mockResolvedValue({
			ok: false,
			frozen: 1,
			skipped: ["a/1", "b/2", "c/3", "d/4", "e/5", "f/6", "g/7"],
			detail: "vantage/globex: select boom",
		});
		freezeAggregates.mockResolvedValue({ ok: true, frozen: 1 });

		await GET(request("Bearer test-secret"));

		expect(sendAlert.mock.calls[0][1]).toContain("skipped 7: a/1, b/2, c/3, d/4, e/5, and 2 more");
	});
});
