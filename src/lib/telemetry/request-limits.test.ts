import { describe, expect, it } from "vitest";
import { MAX_OBSERVE_BODY_BYTES, readBodyWithLimit } from "./request-limits";

function requestWith(body: string, extraHeaders: Record<string, string> = {}): Request {
	return new Request("https://app.letterprove.com/api/v1/observe", {
		method: "POST",
		headers: { "content-type": "text/plain", ...extraHeaders },
		body,
	});
}

describe("readBodyWithLimit", () => {
	it("returns the body when under the limit", async () => {
		const body = JSON.stringify({ k: "x" });

		await expect(readBodyWithLimit(requestWith(body), MAX_OBSERVE_BODY_BYTES)).resolves.toBe(body);
	});

	it("rejects via Content-Length before reading anything, when the header overstates the size", async () => {
		const result = await readBodyWithLimit(
			requestWith("small", { "content-length": String(100 * 1024) }),
			MAX_OBSERVE_BODY_BYTES
		);

		expect(result).toBeUndefined();
	});

	it("rejects a body that exceeds the limit even without a (correct) Content-Length", async () => {
		const oversized = "x".repeat(MAX_OBSERVE_BODY_BYTES + 1);

		await expect(readBodyWithLimit(requestWith(oversized), MAX_OBSERVE_BODY_BYTES)).resolves.toBeUndefined();
	});

	it("accepts a body sitting exactly at the limit", async () => {
		const exact = "x".repeat(MAX_OBSERVE_BODY_BYTES);

		await expect(readBodyWithLimit(requestWith(exact), MAX_OBSERVE_BODY_BYTES)).resolves.toBe(exact);
	});
});
