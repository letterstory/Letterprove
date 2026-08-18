import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectionHealth } from "./health";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/fixtures/vendors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/fixtures/vendors")>()),
	allVendors: vi.fn(),
}));

const HOUR = 3_600_000;

/**
 * Two chains hit this: a head-count (`.select(_, {head}).eq().gte()`) and a
 * latest-row lookup (`.select().eq().order().limit()`). `eq` returns both
 * continuations so either can follow.
 */
function mockDb(opts: { counts: number[]; lastEventAt: string | null }) {
	const counts = [...opts.counts];
	const gte = vi.fn(async () => ({ count: counts.shift() ?? 0, error: null }));
	const limit = vi.fn(async () => ({
		data: opts.lastEventAt ? [{ receipt_ts: opts.lastEventAt }] : [],
		error: null,
	}));
	const order = vi.fn(() => ({ limit }));
	const eq = vi.fn(() => ({ gte, order }));
	const select = vi.fn(() => ({ eq }));
	return { from: vi.fn(() => ({ select })) };
}

async function withVendor(db: unknown) {
	const { dbClient } = await import("@/lib/db/client");
	const { allVendors } = await import("@/lib/fixtures/vendors");
	vi.mocked(allVendors).mockResolvedValue([
		{ slug: "lettertrace", domain: "lettertrace.com", customers: [], name: "", category: "", key: "" },
	] as never);
	vi.mocked(dbClient).mockReturnValue(db as never);
}

beforeEach(() => vi.clearAllMocks());

describe("collectionHealth", () => {
	// "No datastore" and "nothing arrived" render identically but only one is
	// an outage, so they must not collapse into the same value.
	it("returns null when there is no datastore, rather than an all-zero table", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { allVendors } = await import("@/lib/fixtures/vendors");
		vi.mocked(allVendors).mockResolvedValue([] as never);
		vi.mocked(dbClient).mockReturnValue(null);

		expect(await collectionHealth()).toBeNull();
	});

	it("reports a vendor with recent events as reporting", async () => {
		await withVendor(mockDb({ counts: [4, 20, 60], lastEventAt: new Date(Date.now() - 2 * HOUR).toISOString() }));

		const [v] = (await collectionHealth())!;
		expect(v.status).toBe("reporting");
		expect(v.events24h).toBe(4);
		expect(v.events7d).toBe(20);
		expect(v.events30d).toBe(60);
		expect(Math.round(v.hoursSinceLastEvent!)).toBe(2);
	});

	// The exact shape of both real outages: events exist, but not lately.
	it("flags a vendor that reported before and has since gone quiet", async () => {
		await withVendor(mockDb({ counts: [0, 8, 30], lastEventAt: new Date(Date.now() - 65 * HOUR).toISOString() }));

		const [v] = (await collectionHealth())!;
		expect(v.status).toBe("silent");
		expect(v.events24h).toBe(0);
		// Still has history — that is what separates silent from never.
		expect(v.events30d).toBe(30);
	});

	// Never installed is a different problem from stopped working, and gets a
	// different label so nobody goes hunting for a break that never existed.
	it("separates a vendor that has never reported from one that stopped", async () => {
		await withVendor(mockDb({ counts: [0, 0, 0], lastEventAt: null }));

		const [v] = (await collectionHealth())!;
		expect(v.status).toBe("never");
		expect(v.hoursSinceLastEvent).toBeNull();
	});

	it("treats a vendor just inside the window as still reporting", async () => {
		await withVendor(mockDb({ counts: [1, 1, 1], lastEventAt: new Date(Date.now() - 23 * HOUR).toISOString() }));
		expect((await collectionHealth())![0].status).toBe("reporting");
	});

	it("sorts silent vendors first, since they are the only rows needing action", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const { allVendors } = await import("@/lib/fixtures/vendors");
		vi.mocked(allVendors).mockResolvedValue([
			{ slug: "healthy", domain: "a.com", customers: [], name: "", category: "", key: "" },
			{ slug: "broken", domain: "b.com", customers: [], name: "", category: "", key: "" },
		] as never);

		// dbClient() is called once for the whole run, so the mock has to route on
		// vendor_slug the way the real query does rather than on call order.
		const perVendor: Record<string, { counts: number[]; lastEventAt: string }> = {
			healthy: { counts: [5, 5, 5], lastEventAt: new Date(Date.now() - HOUR).toISOString() },
			broken: { counts: [0, 1, 1], lastEventAt: new Date(Date.now() - 80 * HOUR).toISOString() },
		};
		const left: Record<string, number[]> = {
			healthy: [...perVendor.healthy.counts],
			broken: [...perVendor.broken.counts],
		};

		vi.mocked(dbClient).mockReturnValue({
			from: () => ({
				select: () => ({
					eq: (_col: string, slug: string) => ({
						gte: async () => ({ count: left[slug].shift() ?? 0, error: null }),
						order: () => ({
							limit: async () => ({
								data: [{ receipt_ts: perVendor[slug].lastEventAt }],
								error: null,
							}),
						}),
					}),
				}),
			}),
		} as never);

		const rows = await collectionHealth();
		expect(rows!.map((r) => r.vendor)).toEqual(["broken", "healthy"]);
		expect(rows!.map((r) => r.status)).toEqual(["silent", "reporting"]);
	});
});
