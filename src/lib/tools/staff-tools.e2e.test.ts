import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * Staff tools (tier_report, record_customer, vendor_roster, collection_health,
 * agentic_read_billing) against a real Postgres schema, through the real
 * dispatchTool. Every one of these currently has only mocked-DB unit test
 * coverage (registry.test.ts's in-memory fake, staff/*.test.ts) — no
 * *.e2e.test.ts/*.schema.test.ts drives the cross-vendor staff surface
 * against real schema, flagged by a 2026-09-28 e2e audit as a real gap given
 * these are the platform's most sensitive reads.
 *
 * Two things this file exists to prove that a mock cannot:
 *   1. The staff ALLOWLIST double-check (dispatchTool re-verifies isStaffUser
 *      regardless of what capabilities a token claims — see the comment on
 *      that check in registry.ts) actually holds when STAFF_USER_IDS is a
 *      real env var read against a real request, not a mocked function call.
 *   2. record_customer's full real chain — classifyDomain -> tierReport (a
 *      real join over hot_rollups + vendor_customers) -> insert -> the unique
 *      (vendor_id, slug) constraint — which registry.test.ts's fake `.from()`
 *      cannot exercise because it never runs the real tierReport join.
 */

const VENDOR_A_ID = randomUUID();
const VENDOR_A_SLUG = "staff-e2e-acme";
const VENDOR_B_ID = randomUUID();
const VENDOR_B_SLUG = "staff-e2e-globex";
const OBSERVED_DOMAIN = "staff-e2e-customer.com";

let pg: PGlite;

beforeAll(async () => {
	pg = await bootstrapPglite();
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id)
		 values ($1, $2, 'Staff E2E Acme', 'staff-e2e-acme.example', 'test', $3, gen_random_uuid())`,
		[VENDOR_A_ID, VENDOR_A_SLUG, `lp_live_${VENDOR_A_SLUG}`],
	);
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id)
		 values ($1, $2, 'Staff E2E Globex', 'staff-e2e-globex.example', 'test', $3, gen_random_uuid())`,
		[VENDOR_B_ID, VENDOR_B_SLUG, `lp_live_${VENDOR_B_SLUG}`],
	);
	// Real usage, so record_customer has something real to promote and
	// tier_report/vendor_roster have something real to count.
	await pg.query(
		`insert into hot_rollups (vendor_slug, domain, window_start, sessions, signups, logins)
		 values ($1, $2, now() - interval '2 hours', 12, 2, 4)`,
		[VENDOR_A_SLUG, OBSERVED_DOMAIN],
	);
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase(pg) as never);
	await pg.query("delete from vendor_customers where domain = $1", [OBSERVED_DOMAIN]);
});

afterEach(() => {
	delete process.env.STAFF_USER_IDS;
});

const STAFF_USER = "staff-e2e-user";
const NON_STAFF_USER = "not-on-the-allowlist";

/**
 * A cross-vendor staff-scoped principal — orgId unset, mirroring a call with
 * no particular org in play (staff:* grants nothing per-vendor). userId is
 * whichever the test wants dispatchTool's allowlist re-check to see.
 */
function staffPrincipal(userId: string): OAuthPrincipal {
	return { tokenId: "t1", vendorId: null, userId, capabilities: ["staff:read", "staff:write"] };
}

function serviceCaller(): OAuthPrincipal {
	return {
		tokenId: "letterstory-service",
		vendorId: null,
		userId: "letterstory-service",
		capabilities: ["vendor:read", "vendor:write", "billing:read"],
		orgId: "e2e-org",
	};
}

describe("staff allowlist re-check, against a real Postgres-backed request (env var, not a mock)", () => {
	it("denies every staff tool to a token that carries staff:* but whose user id isn't on STAFF_USER_IDS", async () => {
		process.env.STAFF_USER_IDS = STAFF_USER;
		const { dispatchTool } = await import("./registry");

		for (const name of ["tier_report", "record_customer", "vendor_roster", "collection_health"] as const) {
			const outcome = await dispatchTool(name, { vendor: VENDOR_A_SLUG, domain: OBSERVED_DOMAIN }, staffPrincipal(NON_STAFF_USER));
			expect(outcome).toEqual({ kind: "denied", capability: name === "record_customer" ? "staff:write" : "staff:read" });
		}
	});

	it("allows every staff tool once STAFF_USER_IDS names the real caller", async () => {
		process.env.STAFF_USER_IDS = STAFF_USER;
		const { dispatchTool } = await import("./registry");

		const roster = await dispatchTool("vendor_roster", {}, staffPrincipal(STAFF_USER));
		expect(roster.kind).toBe("result");

		const health = await dispatchTool("collection_health", {}, staffPrincipal(STAFF_USER));
		expect(health.kind).toBe("result");

		const report = await dispatchTool("tier_report", { vendor: VENDOR_A_SLUG }, staffPrincipal(STAFF_USER));
		expect(report.kind).toBe("result");
	});

	it("an unset STAFF_USER_IDS denies everyone, including a name that would otherwise match an empty string", async () => {
		delete process.env.STAFF_USER_IDS;
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("vendor_roster", {}, staffPrincipal(""));
		expect(outcome).toEqual({ kind: "denied", capability: "staff:read" });
	});
});

describe("vendor_roster, against real Postgres", () => {
	it("counts every real vendor with its real customer counts", async () => {
		process.env.STAFF_USER_IDS = STAFF_USER;
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool("vendor_roster", {}, staffPrincipal(STAFF_USER));
		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected ok result");

		const slugs = (outcome.result.body as { vendors: { slug: string }[] }).vendors.map((v) => v.slug);
		expect(slugs).toEqual(expect.arrayContaining([VENDOR_A_SLUG, VENDOR_B_SLUG]));
	});
});

describe("record_customer's full real chain (classifyDomain -> tierReport join -> insert), against real Postgres", () => {
	it("promotes an observed, unrecorded company domain into a real customer row", async () => {
		process.env.STAFF_USER_IDS = STAFF_USER;
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"record_customer",
			{ vendor: VENDOR_A_SLUG, domain: OBSERVED_DOMAIN },
			staffPrincipal(STAFF_USER),
		);

		expect(outcome).toMatchObject({
			kind: "result",
			result: { ok: true, status: 201, body: { customer: { domain: OBSERVED_DOMAIN } } },
		});

		const { rows } = await pg.query(
			"select tier, verified, consent from vendor_customers where vendor_id = $1 and domain = $2",
			[VENDOR_A_ID, OBSERVED_DOMAIN],
		);
		expect(rows).toEqual([{ tier: 1, verified: false, consent: "anonymous" }]);
	});

	it("refuses to promote a domain never observed for that vendor — no row, no false positive", async () => {
		process.env.STAFF_USER_IDS = STAFF_USER;
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"record_customer",
			{ vendor: VENDOR_A_SLUG, domain: "never-seen-anywhere.com" },
			staffPrincipal(STAFF_USER),
		);

		expect(outcome).toMatchObject({ kind: "result", result: { ok: false, status: 422, body: { error: "not_observed" } } });
		const { rows } = await pg.query("select 1 from vendor_customers where domain = $1", ["never-seen-anywhere.com"]);
		expect(rows).toHaveLength(0);
	});

	it("refuses a second promotion of an already-recorded domain, through the real unique constraint's own error path", async () => {
		process.env.STAFF_USER_IDS = STAFF_USER;
		const { dispatchTool } = await import("./registry");

		await dispatchTool("record_customer", { vendor: VENDOR_A_SLUG, domain: OBSERVED_DOMAIN }, staffPrincipal(STAFF_USER));
		const second = await dispatchTool(
			"record_customer",
			{ vendor: VENDOR_A_SLUG, domain: OBSERVED_DOMAIN },
			staffPrincipal(STAFF_USER),
		);

		expect(second).toMatchObject({ kind: "result", result: { ok: false, status: 409, body: { error: "already_exists" } } });
		const { rows } = await pg.query("select count(*)::int as n from vendor_customers where domain = $1", [OBSERVED_DOMAIN]);
		expect((rows[0] as { n: number }).n).toBe(1);
	});
});

describe("agentic_read_billing rides billing:read on the plain service identity, not staff:read", () => {
	it("a Letterstory-service caller with no staff grant at all can still read the billing report", async () => {
		// Deliberately no STAFF_USER_IDS set at all — proves this tool needs no
		// staff allowlist membership, matching its own code comment.
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("agentic_read_billing", {}, serviceCaller());
		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected ok result");
		expect(outcome.result.body).toHaveProperty("billing_month");
		expect(outcome.result.body).toHaveProperty("vendors");
	});

	it("a caller without billing:read is denied regardless of any staff grant", async () => {
		process.env.STAFF_USER_IDS = STAFF_USER;
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("agentic_read_billing", {}, staffPrincipal(STAFF_USER));
		expect(outcome).toEqual({ kind: "denied", capability: "billing:read" });
	});
});
