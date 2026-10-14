import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth/ratelimit", () => ({ oauthRateLimit: vi.fn(), oauthClientIp: vi.fn(() => "203.0.113.9") }));
vi.mock("@/lib/fixtures/vendors", () => ({ findVendorByKey: vi.fn() }));
vi.mock("@/lib/telemetry/record", () => ({ recordObservation: vi.fn() }));
vi.mock("@/lib/vendors/hosts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vendors/hosts")>()),
	acceptedHosts: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/telemetry/rejected-origins", () => ({ recordRejectedOrigin: vi.fn() }));
vi.mock("@/lib/telemetry/first-event", () => ({ markFirstEvent: vi.fn() }));
vi.mock("@/lib/vendors/domain-claim", () => ({ rivalHoldsDomain: vi.fn(async () => false) }));

import { oauthRateLimit } from "@/lib/oauth/ratelimit";
import { findVendorByKey } from "@/lib/fixtures/vendors";
import { recordObservation } from "@/lib/telemetry/record";
import { acceptedHosts } from "@/lib/vendors/hosts";
import { recordRejectedOrigin } from "@/lib/telemetry/rejected-origins";
import { markFirstEvent } from "@/lib/telemetry/first-event";
import { rivalHoldsDomain } from "@/lib/vendors/domain-claim";
import { POST } from "./route";

// Verified, because every test below the refusal ones is about some other
// rule and would otherwise be testing the verification gate by accident.
const VENDOR = {
	id: "v-1",
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

describe("POST /api/v1/observe — vendors without DNS proof", () => {
	// DNS is optional since 2026-10-14 (lib/attest/domain-proof.ts): an
	// unproven vendor collects, and its proof is graded tier 0 or site-verified.
	it("collects from the vendor's exact domain without DNS proof", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue({ ...VENDOR, domainVerified: false } as never);

		await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(recordObservation).toHaveBeenCalled();
	});

	it("does not auto-accept hosts beneath an unproven domain", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue({ ...VENDOR, domainVerified: false } as never);

		await post(VALID_BODY, { origin: "https://app.lettertrace.com" });

		expect(recordObservation).not.toHaveBeenCalled();
		expect(recordRejectedOrigin).toHaveBeenCalledWith("v-1", "app.lettertrace.com");
	});

	it("accepts the host its site proof was found on, and hosts it added, exactly", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue({
			...VENDOR,
			domainVerified: false,
			siteVerifiedAt: "2026-10-14T00:00:00Z",
			siteVerifiedUrl: "https://app.lettertrace.com/login",
		} as never);
		vi.mocked(acceptedHosts).mockResolvedValue(new Set(["eu.lettertrace.com"]));

		await post(VALID_BODY, { origin: "https://app.lettertrace.com" });
		await post(VALID_BODY, { origin: "https://eu.lettertrace.com" });
		await post(VALID_BODY, { origin: "https://us.lettertrace.com" });

		expect(recordObservation).toHaveBeenCalledTimes(2);
	});

	it("refuses an unproven vendor once another vendor has proven the domain by DNS", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue({ ...VENDOR, domainVerified: false } as never);
		vi.mocked(rivalHoldsDomain).mockResolvedValueOnce(true);

		const res = await post(VALID_BODY, { origin: "https://lettertrace.com" });

		expect(res.status).toBe(204);
		expect(recordObservation).not.toHaveBeenCalled();
	});

	it("still auto-accepts hosts beneath a DNS-proven domain", async () => {
		await post(VALID_BODY, { origin: "https://app.lettertrace.com" });

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
			geo: { country: null, region: null },
		});
	});

	it("takes location from the edge headers, never from the payload", () => {
		// Same trust rule as receipt_ts and origin: anything a vendor could
		// write is not evidence. A payload claiming to be in Germany while the
		// edge says the request came from the US must record the US.
		return post(
			{ ...VALID_BODY, country: "DE", region: "BE" },
			{
				origin: "https://lettertrace.com",
				headers: { "x-vercel-ip-country": "us", "x-vercel-ip-country-region": "ca" },
			}
		).then(() => {
			expect(recordObservation).toHaveBeenCalledWith(
				expect.objectContaining({ geo: { country: "US", region: "CA" } })
			);
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

	it("rejects when Origin doesn't match the vendor's registered domain, and counts the origin", async () => {
		const res = await post(VALID_BODY, { origin: "https://evil.example" });

		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(recordObservation).not.toHaveBeenCalled();
		expect(recordRejectedOrigin).toHaveBeenCalledWith("v-1", "evil.example");
	});

	it("accepts any host beneath the verified domain without a lookup, and records its real origin", async () => {
		for (const origin of ["https://app.lettertrace.com", "https://www.lettertrace.com", "https://eu.app.lettertrace.com"]) {
			const res = await post(VALID_BODY, { origin });
			expect(res.headers.get("x-letterprove")).not.toBe("off");
		}
		expect(acceptedHosts).not.toHaveBeenCalled();
		expect(vi.mocked(recordObservation).mock.calls.at(-1)?.[0].origin).toBe("eu.app.lettertrace.com");
		expect(markFirstEvent).toHaveBeenCalledWith("v-1");
	});

	it("accepts a sibling host only once it is added and proven", async () => {
		vi.mocked(findVendorByKey).mockResolvedValue({ ...VENDOR, domain: "app.lettertrace.com" } as never);
		vi.mocked(acceptedHosts).mockResolvedValueOnce(new Set(["www.lettertrace.com"]));
		const ok = await post(VALID_BODY, { origin: "https://www.lettertrace.com" });
		expect(ok.headers.get("x-letterprove")).not.toBe("off");
		expect(acceptedHosts).toHaveBeenCalledWith("v-1");

		vi.mocked(acceptedHosts).mockResolvedValueOnce(new Set(["www.lettertrace.com"]));
		const res = await post(VALID_BODY, { origin: "https://eu.lettertrace.com" });
		expect(res.headers.get("x-letterprove")).toBe("off");
		expect(recordRejectedOrigin).toHaveBeenCalledWith("v-1", "eu.lettertrace.com");
	});

	it("never looks up hosts for the vendor's own domain", async () => {
		vi.mocked(acceptedHosts).mockClear();
		await post(VALID_BODY, { origin: "https://lettertrace.com" });
		expect(acceptedHosts).not.toHaveBeenCalled();
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
