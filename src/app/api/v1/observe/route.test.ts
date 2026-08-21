import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth/ratelimit", () => ({ oauthRateLimit: vi.fn(), oauthClientIp: vi.fn(() => "203.0.113.9") }));
vi.mock("@/lib/fixtures/vendors", () => ({ findVendorByKey: vi.fn() }));
vi.mock("@/lib/telemetry/record", () => ({ recordObservation: vi.fn() }));

import { oauthRateLimit } from "@/lib/oauth/ratelimit";
import { findVendorByKey } from "@/lib/fixtures/vendors";
import { recordObservation } from "@/lib/telemetry/record";
import { POST } from "./route";

// Verified, because every test below the refusal ones is about some other
// rule and would otherwise be testing the verification gate by accident.
const VENDOR = {
	slug: "lettertrace",
	name: "Lettertrace",
	domain: "lettertrace.com",
	category: "x",
	key: "lp_live_x",
	domainVerified: true,
	customers: [],
};

function post(body: unknown, { origin, headers }: { origin?: string; headers?: Record<string, string> } = {}) {
	const payload = typeof body === "string" ? body : JSON.stringify(body);
	return POST(
		new Request("https://app.letterprove.com/api/v1/observe", {
			method: "POST",
			headers: { "content-type": "text/plain", ...(origin !== undefined ? { origin } : {}), ...headers },
			body: payload,
		})
	);
}

const VALID_BODY = { k: "lp_live_x", domain: "acme.com", ev: "session", cfg: 1, ts: 1754870400 };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(oauthRateLimit).mockResolvedValue(true);
	vi.mocked(findVendorByKey).mockResolvedValue(VENDOR as never);
	vi.mocked(recordObservation).mockResolvedValue(undefined);
});

describe("POST /api/v1/observe — unverified vendors", () => {
	it("refuses an event from a vendor who has not proven domain control", async () => {
		// Not merely uncounted: refused. If an unverified vendor could still
		// collect, whoever registers a domain first builds up history on it
		// before the real owner ever arrives.
		vi.mocked(findVendorByKey).mockResolvedValue({ ...VENDOR, domainVerified: false } as never);

		const res = await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(res.headers.get("x-letterprove")).not.toBe("ok");
		expect(recordObservation).not.toHaveBeenCalled();
	});

	it("still answers 204, because this endpoint never leaks collection state", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue({ ...VENDOR, domainVerified: false } as never);

		const res = await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(res.status).toBe(204);
	});

	it("accepts once the same vendor is verified", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue({ ...VENDOR, domainVerified: true } as never);

		await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(recordObservation).toHaveBeenCalled();
	});
});

describe("POST /api/v1/observe", () => {
	it("always answers 204 with status carried only in x-letterprove — even on acceptance", async () => {
		const res = await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(res.status).toBe(204);
		expect(res.headers.get("x-letterprove")).toBe("on");
		expect(await res.text()).toBe("");
	});

	it("accepts a well-formed event from the vendor's own origin and records it", async () => {
		const res = await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(res.headers.get("x-letterprove")).toBe("on");
		expect(recordObservation).toHaveBeenCalledWith({
			vendor: "lettertrace",
			domain: "acme.com",
			ev: "session",
			cfg: 1,
			origin: "lettertrace.com",
		});
	});

	it("rejects (204/off) malformed JSON without touching the vendor lookup", async () => {
		const res = await post("{not json", { origin: "https://lettertrace.com" });

		expect(res.status).toBe(204);
		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(findVendorByKey).not.toHaveBeenCalled();
	});

	it("rejects an unknown key", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue(undefined);

		const res = await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(recordObservation).not.toHaveBeenCalled();
	});

	it("rejects when Origin is missing", async () => {
		const res = await post(VALID_BODY);

		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(recordObservation).not.toHaveBeenCalled();
	});

	it("rejects when Origin doesn't match the vendor's registered domain", async () => {
		const res = await post(VALID_BODY, { origin: "https://evil.example" });

		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(recordObservation).not.toHaveBeenCalled();
	});

	it("rejects a request over the size cap via Content-Length, before any DB work", async () => {
		const res = await post(VALID_BODY, {
			origin: "https://lettertrace.com",
			headers: { "content-length": String(9 * 1024) },
		});

		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(findVendorByKey).not.toHaveBeenCalled();
		expect(recordObservation).not.toHaveBeenCalled();
	});

	it("rejects once the IP bucket is exhausted, before reading the body or hitting the DB", async () => {
		vi.mocked(oauthRateLimit).mockImplementation(async (bucket) => !bucket.startsWith("observe:ip:"));

		const res = await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(findVendorByKey).not.toHaveBeenCalled();
		expect(recordObservation).not.toHaveBeenCalled();
	});

	it("rejects once the vendor's own bucket is exhausted, even with a valid key and origin", async () => {
		vi.mocked(oauthRateLimit).mockImplementation(async (bucket) => !bucket.startsWith("observe:vendor:"));

		const res = await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(recordObservation).not.toHaveBeenCalled();
	});

	it("scopes the IP bucket to the caller's IP and the vendor bucket to the resolved vendor slug", async () => {
		await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(oauthRateLimit).toHaveBeenCalledWith("observe:ip:203.0.113.9", 60, expect.any(Number));
		expect(oauthRateLimit).toHaveBeenCalledWith("observe:vendor:lettertrace", 60, expect.any(Number));
	});
});
