import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LETTERSTORY_SERVICE_IDENTITY } from "@/lib/oauth-auth";

vi.mock("@/lib/db/client", () => ({ dbClient: () => null }));
vi.mock("@/lib/tiers/report", () => ({ tierReport: vi.fn(async () => null) }));
vi.mock("@/lib/attest/proofs", () => ({ vendorSlugs: vi.fn(async () => []), vendorSnapshots: vi.fn() }));
vi.mock("@/lib/staff/promote", () => ({ promoteDomain: vi.fn(async () => ({ ok: false, reason: "not_observed", detail: "x" })) }));

/**
 * After #124 retired Letterprove's own dashboard and OAuth server, the two
 * staff tools stayed in the registry with no caller able to reach them: the
 * only remaining door granted vendor:* and nothing else. These assert the
 * round trip is closed again — not that the handlers work (their own tests do
 * that), but that dispatchTool lets a staff principal THROUGH and keeps a
 * non-staff one out.
 */

const STAFF = "22222222-2222-2222-2222-222222222222";
let saved: string | undefined;

function principal(userId: string, capabilities: string[]) {
	return { tokenId: LETTERSTORY_SERVICE_IDENTITY, vendorId: "v1", userId, capabilities, orgId: "o1" } as never;
}

beforeEach(() => {
	saved = process.env.STAFF_USER_IDS;
	process.env.STAFF_USER_IDS = STAFF;
});
afterEach(() => {
	if (saved === undefined) delete process.env.STAFF_USER_IDS;
	else process.env.STAFF_USER_IDS = saved;
});

describe("the staff tools are reachable again", () => {
	it("lets a staff principal into tier_report", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("tier_report", {}, principal(STAFF, ["vendor:read", "staff:read"]));
		// Reached the handler rather than being denied at the gate.
		expect(outcome.kind).toBe("result");
	});

	it("lets a staff principal into record_customer", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool(
			"record_customer",
			{ vendor: "acme", domain: "globex.com" },
			principal(STAFF, ["vendor:write", "staff:write"]),
		);
		expect(outcome.kind).toBe("result");
	});

	/*
	 * dispatchTool re-checks the allowlist itself rather than trusting the
	 * capability list it was handed. Both layers have to agree, so a bug that
	 * widened the grant alone would still not open the tool.
	 */
	it("still refuses a forged capability list from a non-staff user", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("tier_report", {}, principal("not-staff", ["staff:read"]));
		expect(outcome).toEqual({ kind: "denied", capability: "staff:read" });
	});
});
