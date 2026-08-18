import { beforeEach, describe, expect, it, vi } from "vitest";
import { vendorRoster } from "./vendors";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/attest/aggregate", () => ({ aggregateBody: vi.fn() }));
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/fixtures/vendors")>()),
	allVendors: vi.fn(),
}));

const VENDOR = {
	slug: "lettertrace",
	name: "Lettertrace",
	domain: "lettertrace.com",
	category: "AI brand monitoring",
	key: "lp_live_lettertrace_abc",
	customers: [
		{ slug: "a", name: "A", domain: "a.com", since: "2024-01", tier: 2, verified: true, consent: "named" },
		{ slug: "b", name: "B", domain: "b.com", since: "2024-02", tier: 2, verified: true, consent: "anonymous" },
		// No consent field at all — must count as withheld, not named.
		{ slug: "c", name: "C", domain: "c.com", since: "2024-03", tier: 1, verified: false },
	],
};

/** Routes by table so member/vendor lookups can differ, plus the auth admin call. */
function mockDb(opts: {
	members?: { vendor_id: string; user_id: string; role: string }[];
	vendors?: { id: string; slug: string }[];
	users?: { id: string; email: string }[];
	memberError?: string;
}) {
	return {
		from: (table: string) => ({
			select: async () => {
				if (table === "vendor_members") {
					return opts.memberError
						? { data: null, error: { message: opts.memberError } }
						: { data: opts.members ?? [], error: null };
				}
				if (table === "vendors") return { data: opts.vendors ?? [], error: null };
				return { data: [], error: null };
			},
		}),
		auth: { admin: { listUsers: async () => ({ data: { users: opts.users ?? [] }, error: null }) } },
	};
}

async function setup(db: unknown, aggregate: unknown = { companies_observed: 15, sessions: 20, tier: 2 }) {
	const { dbClient } = await import("@/lib/db/client");
	const { allVendors } = await import("@/lib/fixtures/vendors");
	const { aggregateBody } = await import("@/lib/attest/aggregate");
	vi.mocked(allVendors).mockResolvedValue([VENDOR] as never);
	vi.mocked(aggregateBody).mockResolvedValue(aggregate as never);
	vi.mocked(dbClient).mockReturnValue(db as never);
}

beforeEach(() => vi.clearAllMocks());

describe("vendorRoster", () => {
	// "No datastore" and "no vendors" render identically; only one is a problem.
	it("returns null without a datastore rather than an empty roster", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);
		expect(await vendorRoster()).toBeNull();
	});

	it("counts named separately from withheld, treating an absent consent field as withheld", async () => {
		await setup(mockDb({}));
		const [v] = (await vendorRoster())!;
		expect(v.customers.total).toBe(3);
		// Only "a" declares named; "b" is anonymous and "c" omits the field.
		expect(v.customers.named).toBe(1);
	});

	it("reports what the vendor actually publishes", async () => {
		await setup(mockDb({}));
		const [v] = (await vendorRoster())!;
		expect(v.aggregate).toEqual({ companies: 15, sessions: 20, tier: 2 });
	});

	// A failed telemetry read is not "publishes nothing" — surfacing 0 companies
	// for it would be a wrong answer rather than a missing one.
	it("keeps an unreadable aggregate distinct from publishing nothing", async () => {
		await setup(mockDb({}), null);
		const [v] = (await vendorRoster())!;
		expect(v.aggregate).toBeNull();
	});

	it("resolves member emails through the vendor id, not by assuming slugs match", async () => {
		await setup(
			mockDb({
				members: [{ vendor_id: "uuid-1", user_id: "u1", role: "owner" }],
				vendors: [{ id: "uuid-1", slug: "lettertrace" }],
				users: [{ id: "u1", email: "casey@letterstory.com" }],
			})
		);
		const [v] = (await vendorRoster())!;
		expect(v.members).toEqual([{ email: "casey@letterstory.com", role: "owner" }]);
	});

	// Seeded vendors have no members. Worth distinguishing from a broken lookup,
	// because there is nobody to contact rather than someone we failed to find.
	it("reports no members for a seeded vendor", async () => {
		await setup(mockDb({ vendors: [{ id: "uuid-1", slug: "lettertrace" }] }));
		expect((await vendorRoster())![0].members).toEqual([]);
	});

	// A support convenience must not take the whole page down.
	it("still returns the roster when the member lookup fails", async () => {
		await setup(mockDb({ memberError: "permission denied" }));
		const rows = await vendorRoster();
		expect(rows).toHaveLength(1);
		expect(rows![0].members).toEqual([]);
		expect(rows![0].customers.total).toBe(3);
	});

	// It ships in the HTML of every authenticated page on the vendor's site, so
	// masking it here would imply a confidentiality it does not have.
	it("exposes the publishable key in full", async () => {
		await setup(mockDb({}));
		expect((await vendorRoster())![0].key).toBe("lp_live_lettertrace_abc");
	});
});
