import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./state", () => ({ shouldSendAlert: vi.fn() }));

import { sendAlert } from "./notify";
import { shouldSendAlert } from "./state";

describe("sendAlert", () => {
	const originalWebhook = process.env.ALERT_WEBHOOK_URL;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		// The behaviour before suppression existed, so every test that is not
		// about suppression keeps testing what it used to.
		vi.mocked(shouldSendAlert).mockResolvedValue({ send: true });
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		if (originalWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
		else process.env.ALERT_WEBHOOK_URL = originalWebhook;
	});

	it("always logs, even with no webhook configured", async () => {
		delete process.env.ALERT_WEBHOOK_URL;

		await sendAlert("collector down", "insert failed: boom");

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("collector down: insert failed: boom"));
	});

	it("posts to ALERT_WEBHOOK_URL when configured", async () => {
		process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
		const fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchMock);

		await sendAlert("collector down", "insert failed: boom");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://hooks.example.com/alert",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining("collector down: insert failed: boom"),
			})
		);
	});

	it("never throws when the webhook delivery itself fails", async () => {
		process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("network down"))
		);

		await expect(sendAlert("collector down", "insert failed: boom")).resolves.toBeUndefined();
	});

	describe("suppression", () => {
		// Only the webhook is rate limited. The log line is the record of how long
		// a condition has been failing and interrupts nobody, so suppressing it
		// would throw away the one thing that makes a re-page readable.
		it("still logs a suppressed repeat, and says it was suppressed", async () => {
			process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);
			vi.mocked(shouldSendAlert).mockResolvedValue({ send: false });

			await sendAlert("collector down", "insert failed: boom");

			expect(fetchMock).not.toHaveBeenCalled();
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("collector down: insert failed: boom"));
			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("page suppressed"));
		});

		it("carries the still-failing context into the page so a re-page is not read as new", async () => {
			process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);
			vi.mocked(shouldSendAlert).mockResolvedValue({
				send: true,
				context: "still failing, ongoing for 8h (30 occurrences)",
			});

			await sendAlert("collector down", "insert failed: boom");

			expect(fetchMock.mock.calls[0][1].body).toContain("still failing, ongoing for 8h (30 occurrences)");
		});

		it("suppresses per subject, so one noisy condition cannot mute a different one", async () => {
			process.env.ALERT_WEBHOOK_URL = "https://hooks.example.com/alert";
			const fetchMock = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetchMock);
			vi.mocked(shouldSendAlert).mockImplementation(async (subject: string) => ({
				send: subject !== "collector down",
			}));

			await sendAlert("collector down", "insert failed: boom");
			await sendAlert("hourly rollup failed (all vendors)", "timeout");

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock.mock.calls[0][1].body).toContain("hourly rollup failed");
		});
	});
});
