import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSupportMessage } from "./slack";

const msg = { vendorName: "Acme", vendorSlug: "acme", userEmail: "a@acme.com", message: "help please" };

describe("sendSupportMessage", () => {
	const originalWebhook = process.env.SUPPORT_SLACK_WEBHOOK_URL;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		if (originalWebhook === undefined) delete process.env.SUPPORT_SLACK_WEBHOOK_URL;
		else process.env.SUPPORT_SLACK_WEBHOOK_URL = originalWebhook;
	});

	it("posts vendor context and the message to the configured webhook", async () => {
		process.env.SUPPORT_SLACK_WEBHOOK_URL = "https://hooks.example.com/support";

		const result = await sendSupportMessage(msg);

		expect(result.ok).toBe(true);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://hooks.example.com/support");
		const body = JSON.parse(init.body);
		expect(body.text).toContain("Acme (acme)");
		expect(body.text).toContain("a@acme.com");
		expect(body.text).toContain("help please");
	});

	it("fails gracefully with no webhook configured, without calling fetch", async () => {
		delete process.env.SUPPORT_SLACK_WEBHOOK_URL;

		const result = await sendSupportMessage(msg);

		expect(result.ok).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails gracefully when Slack rejects the request", async () => {
		process.env.SUPPORT_SLACK_WEBHOOK_URL = "https://hooks.example.com/support";
		fetchMock.mockResolvedValue({ ok: false, status: 404 });

		const result = await sendSupportMessage(msg);

		expect(result.ok).toBe(false);
	});

	it("never throws when the webhook delivery itself fails", async () => {
		process.env.SUPPORT_SLACK_WEBHOOK_URL = "https://hooks.example.com/support";
		fetchMock.mockRejectedValue(new Error("network down"));

		await expect(sendSupportMessage(msg)).resolves.toEqual(
			expect.objectContaining({ ok: false }),
		);
	});
});
