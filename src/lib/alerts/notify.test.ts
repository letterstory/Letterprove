import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAlert } from "./notify";

describe("sendAlert", () => {
	const originalWebhook = process.env.ALERT_WEBHOOK_URL;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		consoleErrorSpy.mockRestore();
		vi.unstubAllGlobals();
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
});
