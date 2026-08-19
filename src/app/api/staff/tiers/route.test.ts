import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/auth/server", () => ({ getUser: vi.fn() }));
vi.mock("@/lib/tiers/report", () => ({ tierReport: vi.fn() }));
vi.mock("@/lib/attest/proofs", () => ({ vendorSlugs: vi.fn() }));

const REQ = new Request("https://example.test/api/staff/tiers");

// Signed in AND on the staff allowlist — the two are separate questions since
// 2026-08-18, when staff surfaces stopped accepting any session as staff.
async function signedIn(is: boolean) {
	const { getUser } = await import("@/lib/auth/server");
	process.env.STAFF_USER_IDS = "u1";
	vi.mocked(getUser).mockResolvedValue(is ? ({ id: "u1" } as never) : null);
}

/** Signed in, but not staff — the case that used to be indistinguishable. */
async function signedInAsOutsider() {
	const { getUser } = await import("@/lib/auth/server");
	process.env.STAFF_USER_IDS = "u1";
	vi.mocked(getUser).mockResolvedValue({ id: "self-registered" } as never);
}

describe("GET /api/staff/tiers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// The gate is load-bearing: the body names customer domains, including ones
	// withheld for consent. A leak here defeats the consent design entirely.
	it("does not serve anything to a signed-out caller", async () => {
		await signedIn(false);
		const { tierReport } = await import("@/lib/tiers/report");

		const res = await GET(REQ);
		expect(res.status).toBe(404);
		// Not merely absent from the body — never computed.
		expect(tierReport).not.toHaveBeenCalled();
	});

	// 404 rather than 401, matching the proof endpoints: an internal surface
	// that confirms its own existence tells people where to push.
	it("hides its existence rather than announcing a forbidden resource", async () => {
		await signedIn(false);
		const body = await (await GET(REQ)).json();
		expect(JSON.stringify(body)).not.toMatch(/unauthor|forbidden/i);
	});

	it("reports every vendor for a signed-in staff user", async () => {
		await signedIn(true);
		const { vendorSlugs } = await import("@/lib/attest/proofs");
		const { tierReport } = await import("@/lib/tiers/report");
		vi.mocked(vendorSlugs).mockResolvedValue(["vantage", "lettertrace"]);
		vi.mocked(tierReport).mockImplementation(
			async (slug: string) => ({ vendor: slug, observed: 1, attributable: 1, unpublishedEvidence: 1, published: 0, rows: [] }) as never,
		);

		const body = await (await GET(REQ)).json();
		expect(body.vendors.map((v: { vendor: string }) => v.vendor)).toEqual(["vantage", "lettertrace"]);
		expect(body.unreadable).toBeUndefined();
	});

	// A vendor whose telemetry could not be read must be named, not silently
	// dropped — an absent vendor reads as "nothing observed", which is the
	// conclusion someone would wrongly act on.
	it("names vendors it could not report on instead of omitting them", async () => {
		await signedIn(true);
		const { vendorSlugs } = await import("@/lib/attest/proofs");
		const { tierReport } = await import("@/lib/tiers/report");
		vi.mocked(vendorSlugs).mockResolvedValue(["vantage", "broken"]);
		vi.mocked(tierReport).mockImplementation(async (slug: string) =>
			slug === "broken" ? null : ({ vendor: slug, observed: 0, attributable: 0, unpublishedEvidence: 0, published: 0, rows: [] } as never),
		);

		const body = await (await GET(REQ)).json();
		expect(body.vendors).toHaveLength(1);
		expect(body.unreadable).toEqual(["broken"]);
	});

	it("scopes to one vendor when asked", async () => {
		await signedIn(true);
		const { tierReport } = await import("@/lib/tiers/report");
		const { vendorSlugs } = await import("@/lib/attest/proofs");
		vi.mocked(tierReport).mockResolvedValue({ vendor: "lettertrace", observed: 0, attributable: 0, unpublishedEvidence: 0, published: 0, rows: [] } as never);

		await GET(new Request("https://example.test/api/staff/tiers?vendor=lettertrace"));
		expect(tierReport).toHaveBeenCalledWith("lettertrace");
		expect(vendorSlugs).not.toHaveBeenCalled();
	});

	// Tier state changes every hour with the rollup; a cached answer would send
	// someone to look at a backlog that has already moved.
	it("is never cached", async () => {
		await signedIn(true);
		const { vendorSlugs } = await import("@/lib/attest/proofs");
		vi.mocked(vendorSlugs).mockResolvedValue([]);

		const res = await GET(REQ);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});
});

/**
 * Until 2026-08-18 this endpoint served every vendor's withheld customer
 * domains to any session, and a session was one signup form away: /staff/login
 * offered self-service registration and Supabase had mailer_autoconfirm on.
 */
describe("staff allowlist", () => {
	it("serves nothing to a signed-in user who is not staff", async () => {
		await signedInAsOutsider();
		const { tierReport } = await import("@/lib/tiers/report");

		const res = await GET(REQ);
		expect(res.status).toBe(404);
		// Never computed, so no withheld domain is even assembled in memory.
		expect(tierReport).not.toHaveBeenCalled();
	});

	// Fails closed: no configured staff means no staff, not everyone.
	it("serves nothing when no allowlist is configured", async () => {
		await signedIn(true);
		delete process.env.STAFF_USER_IDS;
		expect((await GET(REQ)).status).toBe(404);
	});
});
