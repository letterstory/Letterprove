import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/rollup/agentic-reads", () => ({
	rollupAgenticReads: vi.fn(),
	pruneAgenticReadEvents: vi.fn(),
}));
vi.mock("@/lib/alerts/notify", () => ({ sendAlert: vi.fn() }));

function request(auth?: string): Request {
	return new Request("https://app.letterprove.com/api/cron/agentic-reads-rollup", {
		headers: auth ? { authorization: auth } : {},
	});
}

async function mocks() {
	return {
		rollupAgenticReads: vi.mocked((await import("@/rollup/agentic-reads")).rollupAgenticReads),
		pruneAgenticReadEvents: vi.mocked((await import("@/rollup/agentic-reads")).pruneAgenticReadEvents),
		sendAlert: vi.mocked((await import("@/lib/alerts/notify")).sendAlert),
		GET: (await import("./route")).GET,
	};
}

describe("GET /api/cron/agentic-reads-rollup", () => {
	const originalSecret = process.env.CRON_SECRET;

	beforeEach(async () => {
		process.env.CRON_SECRET = "test-secret";
		(await mocks()).pruneAgenticReadEvents.mockResolvedValue({ ok: true, deleted: 0 });
	});

	afterEach(() => {
		if (originalSecret === undefined) delete process.env.CRON_SECRET;
		else process.env.CRON_SECRET = originalSecret;
		vi.clearAllMocks();
	});

	it("fails closed with 401 when CRON_SECRET is unset", async () => {
		delete process.env.CRON_SECRET;
		const { GET, rollupAgenticReads, pruneAgenticReadEvents } = await mocks();

		expect((await GET(request("Bearer whatever"))).status).toBe(401);
		expect(rollupAgenticReads).not.toHaveBeenCalled();
		expect(pruneAgenticReadEvents).not.toHaveBeenCalled();
	});

	it("rejects a request with the wrong bearer token", async () => {
		const { GET } = await mocks();

		expect((await GET(request("Bearer nope"))).status).toBe(401);
	});

	it("returns 200 and alerts nobody on a healthy run", async () => {
		const { GET, rollupAgenticReads, sendAlert } = await mocks();
		rollupAgenticReads.mockResolvedValue({ ok: true });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, prune: { ok: true, deleted: 0 } });
		expect(sendAlert).not.toHaveBeenCalled();
	});

	it("returns 500 and pages with the scope named when the rollup fails", async () => {
		const { GET, rollupAgenticReads, sendAlert } = await mocks();
		rollupAgenticReads.mockResolvedValue({ ok: false, detail: "rollup_agentic_reads_daily: deadlock detected" });

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledWith(
			"agentic-read billing rollup failed (all vendors)",
			"rollup_agentic_reads_daily: deadlock detected"
		);
	});

	it("alerts instead of crashing when the rollup itself throws", async () => {
		const { GET, rollupAgenticReads, sendAlert } = await mocks();
		rollupAgenticReads.mockRejectedValue(new Error("connection reset"));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(500);
		expect(sendAlert).toHaveBeenCalledWith(
			"agentic-read billing rollup failed (all vendors)",
			expect.stringContaining("connection reset")
		);
	});

	it("still prunes when the rollup fails", async () => {
		const { GET, rollupAgenticReads, pruneAgenticReadEvents } = await mocks();
		rollupAgenticReads.mockResolvedValue({ ok: false, detail: "boom" });

		await GET(request("Bearer test-secret"));

		expect(pruneAgenticReadEvents).toHaveBeenCalledOnce();
	});

	it("pages on a failed prune without failing the run", async () => {
		const { GET, rollupAgenticReads, pruneAgenticReadEvents, sendAlert } = await mocks();
		rollupAgenticReads.mockResolvedValue({ ok: true });
		pruneAgenticReadEvents.mockResolvedValue({
			ok: false,
			detail: "permission denied for function prune_agentic_read_events",
		});

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(200);
		expect(sendAlert).toHaveBeenCalledWith(
			"agentic-read event prune failed (all vendors)",
			"permission denied for function prune_agentic_read_events"
		);
	});

	it("pages instead of crashing when the prune throws", async () => {
		const { GET, rollupAgenticReads, pruneAgenticReadEvents, sendAlert } = await mocks();
		rollupAgenticReads.mockResolvedValue({ ok: true });
		pruneAgenticReadEvents.mockRejectedValue(new Error("socket hang up"));

		const res = await GET(request("Bearer test-secret"));

		expect(res.status).toBe(200);
		expect(sendAlert).toHaveBeenCalledWith(
			"agentic-read event prune failed (all vendors)",
			expect.stringContaining("socket hang up")
		);
	});
});
