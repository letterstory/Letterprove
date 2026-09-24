import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendConsentRequest } from "./consent";

/**
 * consent.ts had zero test coverage before this file — see the audit that
 * flagged it. It's the delivery step that binds a counter-signature to the
 * customer's own mailbox (per the module's own top comment), so what matters
 * here isn't just "it calls fetch": it's the exact request Resend receives,
 * that a customer can actually reply to it, and that every failure mode
 * returns `ok: false` rather than throwing up through the caller (which would
 * skip the token rollback in registry.ts).
 */

const MSG = {
	to: "ops@acme.example",
	vendorName: "Acme Corp",
	customerName: "Acme",
	url: "https://app.letterprove.com/attest/acme-corp/acme/consent?token=tok123",
	expiresAt: "2026-12-31T00:00:00.000Z",
};

describe("sendConsentRequest", () => {
	const originalKey = process.env.RESEND_API_KEY;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		process.env.RESEND_API_KEY = "re_test_key";
		fetchMock = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		if (originalKey === undefined) delete process.env.RESEND_API_KEY;
		else process.env.RESEND_API_KEY = originalKey;
	});

	it("posts to Resend's send endpoint with a bearer-authenticated request", async () => {
		const result = await sendConsentRequest(MSG);

		expect(result).toEqual({ ok: true });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.resend.com/emails");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer re_test_key");
		expect(init.headers["Content-Type"]).toBe("application/json");
	});

	it("sends to the customer's contact address, from the verified letterprove.com sender", async () => {
		await sendConsentRequest(MSG);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.to).toEqual(["ops@acme.example"]);
		expect(body.from).toBe("Letterprove <staff@letterprove.com>");
	});

	// The bug this closes: staff@letterprove.com is send-only, so a customer
	// who hits "reply" on this email — the one email in the product with no
	// Letterprove account behind it — had nowhere for that reply to go.
	it("sets reply-to so a customer reply reaches a real support inbox", async () => {
		await sendConsentRequest(MSG);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.reply_to).toBe("support@letterbrace.com");
	});

	it("names the vendor and customer in the subject, since the recipient has no other context", async () => {
		await sendConsentRequest(MSG);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.subject).toBe("Acme Corp would like to name Acme as a customer");
	});

	it("carries the consent URL and expiry in both the html and text bodies", async () => {
		await sendConsentRequest(MSG);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.html).toContain(MSG.url);
		expect(body.text).toContain(MSG.url);
		expect(body.text).toContain("December 31, 2026");
	});

	it("HTML-escapes vendor and customer names, since both are vendor-supplied", async () => {
		await sendConsentRequest({ ...MSG, vendorName: '<script>alert(1)</script>', customerName: "A & B" });

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.html).not.toContain("<script>");
		expect(body.html).toContain("&lt;script&gt;");
		expect(body.html).toContain("A &amp; B");
	});

	it("refuses to send with no RESEND_API_KEY configured, without calling fetch", async () => {
		delete process.env.RESEND_API_KEY;

		const result = await sendConsentRequest(MSG);

		expect(result).toEqual({
			ok: false,
			error: "Email delivery isn't configured yet, so consent links can't be sent.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("fails with a vendor-safe message when Resend rejects the request, never echoing its body", async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve('{"message":"invalid to: ops@acme.example"}') });

		const result = await sendConsentRequest(MSG);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("Couldn't send the consent email. Check the address and try again.");
			expect(result.error).not.toContain("ops@acme.example");
		}
	});

	it("never throws when the Resend request itself fails, so the caller's rollback always runs", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));

		await expect(sendConsentRequest(MSG)).resolves.toEqual({
			ok: false,
			error: "Couldn't send the consent email. Please try again.",
		});
	});
});
