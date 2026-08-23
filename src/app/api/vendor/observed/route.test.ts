import { describe, expect, it, vi, beforeEach } from "vitest";
import { GET, POST } from "./route";
import { currentVendor } from "@/lib/vendors/session";
import { tierReport } from "@/lib/tiers/report";
import { promoteDomain } from "@/lib/staff/promote";

vi.mock("@/lib/vendors/session", () => ({ currentVendor: vi.fn() }));
vi.mock("@/lib/tiers/report", () => ({ tierReport: vi.fn() }));
vi.mock("@/lib/staff/promote", () => ({ promoteDomain: vi.fn() }));

const VENDOR = { id: "v1", slug: "lettertrace" };

const REPORT = {
	vendor: "lettertrace",
	observed: 49,
	attributable: 45,
	unpublishedEvidence: 45,
	published: 0,
	rows: [
		{
			domain: "des-ai.com",
			kind: "company",
			sessions: 5,
			signups: 4,
			logins: 0,
			customer: null,
			assertedTier: null,
			earnedTier: null,
			consent: null,
			status: "no-customer-record",
			detail: "observed and attributable — no customer record exists yet",
		},
	],
};

function post(body: unknown) {
	return POST(
		new Request("https://app.letterprove.com/api/vendor/observed", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentVendor).mockResolvedValue(VENDOR as never);
	vi.mocked(tierReport).mockResolvedValue(REPORT as never);
});

describe("GET /api/vendor/observed", () => {
	it("requires a session", async () => {
		vi.mocked(currentVendor).mockResolvedValue(null as never);

		expect((await GET()).status).toBe(401);
	});

	it("reports on the SESSION's vendor, never one from the caller", async () => {
		// The scoping guarantee. tierReport() will happily report on any vendor
		// it is given, so the only thing standing between a vendor and everyone
		// else's customer list is that the slug comes from the session.
		await GET();

		expect(tierReport).toHaveBeenCalledWith("lettertrace");
		expect(tierReport).toHaveBeenCalledTimes(1);
	});

	it("returns the observed domains with their counts and status", async () => {
		const body = await (await GET()).json();

		expect(body.observed).toBe(49);
		expect(body.awaiting).toBe(45);
		expect(body.domains[0]).toMatchObject({
			domain: "des-ai.com",
			events: 9,
			status: "no-customer-record",
		});
	});

	it("503s on a failed telemetry read rather than reporting zero domains", async () => {
		// "No companies observed" would tell a vendor their install is broken
		// when it may be perfectly fine. A failed read is not an empty result.
		vi.mocked(tierReport).mockResolvedValue(null as never);

		const res = await GET();

		expect(res.status).toBe(503);
		expect((await res.json()).error).toMatch(/telemetry/i);
	});
});

describe("POST /api/vendor/observed", () => {
	it("requires a session", async () => {
		vi.mocked(currentVendor).mockResolvedValue(null as never);

		expect((await post({ domain: "des-ai.com" })).status).toBe(401);
	});

	it("promotes against the session's vendor, ignoring any slug in the body", async () => {
		// The attack this refuses: posting someone else's vendor slug to create
		// a customer record on their account.
		vi.mocked(promoteDomain).mockResolvedValue({
			ok: true,
			slug: "des-ai",
			name: "Des Ai",
			domain: "des-ai.com",
		} as never);

		await post({ domain: "des-ai.com", vendor: "some-other-vendor", vendorSlug: "another" });

		expect(promoteDomain).toHaveBeenCalledWith("lettertrace", "des-ai.com");
	});

	it("returns the created record", async () => {
		vi.mocked(promoteDomain).mockResolvedValue({
			ok: true,
			slug: "des-ai",
			name: "Des Ai",
			domain: "des-ai.com",
		} as never);

		const res = await post({ domain: "des-ai.com" });

		expect(res.status).toBe(201);
		expect((await res.json()).customer).toEqual({
			slug: "des-ai",
			name: "Des Ai",
			domain: "des-ai.com",
		});
	});

	it("rejects a missing domain", async () => {
		expect((await post({})).status).toBe(400);
		expect(promoteDomain).not.toHaveBeenCalled();
	});

	it("rejects a malformed body without calling promote", async () => {
		const res = await POST(
			new Request("https://app.letterprove.com/api/vendor/observed", {
				method: "POST",
				body: "{not json",
			})
		);

		expect(res.status).toBe(400);
		expect(promoteDomain).not.toHaveBeenCalled();
	});

	it("409s when the domain is already a customer", async () => {
		vi.mocked(promoteDomain).mockResolvedValue({
			ok: false,
			reason: "already_exists",
			detail: 'already recorded as "des-ai"',
		} as never);

		expect((await post({ domain: "des-ai.com" })).status).toBe(409);
	});

	it("400s with the refusal reason for an unobservable domain", async () => {
		// Promotion refuses domains with no observed traffic. A vendor must not
		// be able to invent a customer through this route.
		vi.mocked(promoteDomain).mockResolvedValue({
			ok: false,
			reason: "not_observed",
			detail: "no traffic observed for this domain",
		} as never);

		const res = await post({ domain: "invented.com" });

		expect(res.status).toBe(400);
		expect((await res.json()).reason).toBe("not_observed");
	});
});
