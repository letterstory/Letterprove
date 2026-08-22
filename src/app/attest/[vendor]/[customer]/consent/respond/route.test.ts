import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/vendors/consent", () => ({ recordConsentDecision: vi.fn() }));

import { recordConsentDecision } from "@/lib/vendors/consent";

function post(fields: Record<string, string>) {
	const body = new URLSearchParams(fields);
	return POST(
		new NextRequest("https://app.letterprove.com/attest/acme/widgets/consent/respond", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		}),
		{ params: Promise.resolve({ vendor: "acme", customer: "widgets" }) },
	);
}

beforeEach(() => vi.clearAllMocks());

describe("POST /attest/[vendor]/[customer]/consent/respond", () => {
	it("records an approval and redirects with done=approve, dropping the token", async () => {
		vi.mocked(recordConsentDecision).mockResolvedValue({ ok: true });

		const res = await post({ token: "tok", decision: "approve" });

		expect(recordConsentDecision).toHaveBeenCalledWith("acme", "widgets", "tok", "approve");
		expect(res.status).toBe(307);
		const location = new URL(res.headers.get("location")!);
		expect(location.pathname).toBe("/attest/acme/widgets/consent");
		expect(location.searchParams.get("done")).toBe("approve");
		expect(location.searchParams.has("token")).toBe(false);
	});

	it("records a decline and redirects with done=decline", async () => {
		vi.mocked(recordConsentDecision).mockResolvedValue({ ok: true });

		const res = await post({ token: "tok", decision: "decline" });

		expect(recordConsentDecision).toHaveBeenCalledWith("acme", "widgets", "tok", "decline");
		const location = new URL(res.headers.get("location")!);
		expect(location.searchParams.get("done")).toBe("decline");
	});

	it("redirects back with the token intact (not done) when the decision fails, so the page can show why", async () => {
		vi.mocked(recordConsentDecision).mockResolvedValue({ ok: false, reason: "invalid" });

		const res = await post({ token: "stale-tok", decision: "approve" });

		const location = new URL(res.headers.get("location")!);
		expect(location.searchParams.get("token")).toBe("stale-tok");
		expect(location.searchParams.has("done")).toBe(false);
	});

	it("redirects without calling recordConsentDecision when the decision field is garbage", async () => {
		const res = await post({ token: "tok", decision: "yolo" });

		expect(recordConsentDecision).not.toHaveBeenCalled();
		const location = new URL(res.headers.get("location")!);
		expect(location.searchParams.has("done")).toBe(false);
	});
});
