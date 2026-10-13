import { describe, expect, it, vi } from "vitest";
import { classifyRow, tierReport } from "./report";
import type { CustomerFixture } from "@/lib/fixtures/vendors";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

// The vendor/customer catalogue is mocked rather than read through the real
// module. These tests are about the tier decision, not about where identity is
// stored — and that storage is moving from static fixtures to Postgres, at
// which point a test that leans on the fixtures would start failing for a
// reason that has nothing to do with what it asserts.
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/fixtures/vendors")>()),
	allVendors: vi.fn(),
}));

function customer(over: Partial<CustomerFixture> & Pick<CustomerFixture, "slug" | "domain">): CustomerFixture {
	return {
		name: over.slug,
		since: "2024-01",
		tier: 2,
		verified: true,
		features: [],
		...over,
	};
}

const VANTAGE = {
	slug: "vantage",
	name: "Vantage",
	domain: "vantage.example",
	category: "demo",
	key: "lp_live_vantage",
	domainVerified: true,
	customers: [
		customer({ slug: "acme-corp", domain: "acme-corp.example" }),
		customer({ slug: "northwind", domain: "northwind.example" }),
		customer({ slug: "globex", domain: "globex.example", tier: 1, verified: false }),
	],
};

const LETTERTRACE = {
	slug: "lettertrace",
	name: "Lettertrace",
	domain: "lettertrace.com",
	category: "real",
	key: "lp_live_lettertrace",
	domainVerified: true,
	customers: [],
};

async function withVendors() {
	const { allVendors } = await import("@/lib/fixtures/vendors");
	vi.mocked(allVendors).mockResolvedValue([VANTAGE, LETTERTRACE] as never);
}

/**
 * Mimics the chainable `.from().select().eq().gte().order().range()` shape.
 *
 * The read pages now (see src/lib/db/read-all.ts), so it finishes at `.range()`
 * rather than `.gte()`. One page is returned, which readAllRows correctly
 * treats as the last — paging past the cap is proven separately in
 * read-all.test.ts, where it can actually be exercised.
 */
function mockDb(result: { data: unknown; error: unknown }) {
	const range = vi.fn().mockResolvedValue(result);
	const order: ReturnType<typeof vi.fn> = vi.fn(() => ({ order, range }));
	const gte = vi.fn().mockReturnValue({ order, range });
	const eq = vi.fn().mockReturnValue({ gte });
	const select = vi.fn().mockReturnValue({ eq });
	const from = vi.fn().mockReturnValue({ select });
	return { from, select, eq, gte, order, range };
}

function rollup(domain: string, sessions: number, signups = 0, logins = 0) {
	return { domain, sessions, signups, logins };
}

async function withRollups(rows: unknown[]) {
	await withVendors();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(mockDb({ data: rows, error: null }) as never);
}

describe("tierReport", () => {
	it("returns null for an unknown vendor", async () => {
		await withRollups([]);
		expect(await tierReport("nope")).toBeNull();
	});

	// A failed read must not read as "nothing observed" — that is the exact
	// conclusion someone would act on, and acting on it means creating customer
	// records for domains that already have them, or concluding collection is
	// broken when it isn't.
	it("returns null when telemetry cannot be read, rather than reporting no evidence", async () => {
		await withVendors();
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ data: null, error: { message: "boom" } }) as never);
		expect(await tierReport("vantage")).toBeNull();
	});

	it("returns null when no datastore is configured", async () => {
		await withVendors();
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);
		expect(await tierReport("vantage")).toBeNull();
	});

	// Since decision 30 every observed company counts in the vendor
	// attestation, customer record or not. The list is private bookkeeping.
	it("counts observed companies whether or not they are on the vendor's list", async () => {
		await withRollups([rollup("tenevents.com", 3), rollup("o3world.com", 1)]);

		const r = await tierReport("lettertrace");
		expect(r!.observed).toBe(2);
		expect(r!.attributable).toBe(2);
		expect(r!.published).toBe(2);
		expect(r!.paying).toBe(0);
		expect(r!.unpublishedEvidence).toBe(2);
		expect(r!.rows.every((x) => x.status === "observed")).toBe(true);
		expect(r!.rows[0].domain).toBe("tenevents.com"); // busiest first
	});

	it("counts nothing while the vendor's domain is unproven", async () => {
		await withRollups([rollup("tenevents.com", 3)]);
		const { allVendors } = await import("@/lib/fixtures/vendors");
		vi.mocked(allVendors).mockResolvedValue([{ ...LETTERTRACE, domainVerified: false }] as never);

		const r = await tierReport("lettertrace");
		expect(r!.published).toBe(0);
		expect(r!.rows[0].earnedTier).toBe(0);
	});

	// Free-mail and our own domains are counted and shown, never publishable.
	it("separates unattributable traffic from a genuine backlog", async () => {
		await withRollups([
			rollup("gmail.com", 5),
			rollup("lettertrace.com", 4),
			rollup("globex.com", 2),
		]);

		const r = await tierReport("lettertrace");
		const byDomain = Object.fromEntries(r!.rows.map((x) => [x.domain, x]));
		expect(byDomain["gmail.com"].status).toBe("not-attributable");
		expect(byDomain["gmail.com"].kind).toBe("free_mail");
		expect(byDomain["lettertrace.com"].kind).toBe("internal");
		expect(byDomain["globex.com"].status).toBe("observed");

		expect(r!.observed).toBe(3);
		expect(r!.attributable).toBe(1);
		// Only the real company counts.
		expect(r!.published).toBe(1);
	});

	// A customer on record with no traffic is as much a finding as traffic with
	// no customer, so the report is the union rather than either side.
	it("includes customers that were never observed at all", async () => {
		await withRollups([]);

		const r = await tierReport("vantage");
		expect(r!.rows.map((x) => x.customer).sort()).toEqual(["acme-corp", "globex", "northwind"]);
		expect(r!.observed).toBe(0);
	});
});

// Every status branch, decoupled from the fixtures. The demo vendor cannot
// reach most of these: its `.example` domains are reserved-TLD by design, so
// they stop at not-attributable before observation is considered.
describe("classifyRow", () => {
	const none = { sessions: 0, signups: 0, logins: 0 };
	const busy = { sessions: 12, signups: 1, logins: 3 };
	const customer = {
		slug: "acme",
		name: "Acme",
		domain: "acme.com",
		since: "2024-01",
		tier: 2 as const,
		verified: true,
		features: [],
	};

	// The stored tier (2 on this fixture) has no effect: tiers come from
	// evidence alone, and observation without payment is tier 1.
	it("counts an observed company at the earned tier", () => {
		const r = classifyRow("acme.com", busy, customer, true);
		expect(r.status).toBe("observed");
		expect(r.earnedTier).toBe(1);
		expect(r).not.toHaveProperty("consent");
	});

	it("marks an observed company with payment evidence as paying, at tier 3", () => {
		const r = classifyRow("acme.com", busy, undefined, true, undefined, true);
		expect(r.status).toBe("paying");
		expect(r.earnedTier).toBe(3);
	});

	it("never counts payment without observed use", () => {
		const r = classifyRow("acme.com", none, customer, true, undefined, true);
		expect(r.status).toBe("no-observation");
		expect(r.earnedTier).toBe(0);
	});

	it("reports a listed company with no evidence at tier 0", () => {
		const r = classifyRow("acme.com", none, customer, true);
		expect(r.status).toBe("no-observation");
		expect(r.earnedTier).toBe(0);
	});

	it("does not publish a leftover counter-signature with zero observation: tier 4 is retired", () => {
		const r = classifyRow("acme.com", none, { ...customer, countersignedAt: "2026-09-01T00:00:00Z" } as never, true);
		expect(r.status).toBe("no-observation");
		expect(r.earnedTier).toBe(0);
	});

	it("counts observed, attributable traffic with no record", () => {
		expect(classifyRow("acme.com", busy, undefined, true).status).toBe("observed");
	});

	// The worst case the ordering exists for: a customer record on a domain that
	// can never name a company. Publishing state is irrelevant while that is true.
	it("puts unattributability ahead of every other status, record or not", () => {
		const onFreeMail = classifyRow("gmail.com", busy, { ...customer, domain: "gmail.com" }, true);
		expect(onFreeMail.status).toBe("not-attributable");
		expect(onFreeMail.kind).toBe("free_mail");

		expect(classifyRow("lettertrace.com", busy, undefined, true).status).toBe("not-attributable");
		expect(classifyRow("probe.invalid", busy, undefined, true).status).toBe("not-attributable");
	});

	// signups and logins are evidence too — a domain seen only at signup has
	// still been observed.
	it("counts any event type as evidence, not just sessions", () => {
		const signupOnly = classifyRow("acme.com", { sessions: 0, signups: 1, logins: 0 }, customer, true);
		expect(signupOnly.status).toBe("observed");
		expect(signupOnly.earnedTier).toBe(1);
	});
});
