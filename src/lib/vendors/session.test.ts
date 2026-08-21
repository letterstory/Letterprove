import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentVendor, vendorMemberships } from "./session";

vi.mock("@/lib/auth/server", () => ({
	createServerSupabaseClient: vi.fn(),
	getUser: vi.fn(),
}));

const VENDOR = {
	id: "v1",
	slug: "acme",
	name: "Acme",
	domain: "acme.com",
	category: "cdp",
	key: "lp_live_acme_x",
};

/**
 * Records the query the caller builds, so the ordering can be asserted.
 * `order` has to be chainable — the real query applies two terms, and a mock
 * that only supports one would pass while the second silently did nothing.
 */
function mockDb(result: unknown) {
	const calls: { orders: [string, unknown][]; limit?: number } = { orders: [] };
	const maybeSingle = vi.fn().mockResolvedValue({ data: result });
	const returns = vi.fn().mockResolvedValue({ data: result });
	const limit = vi.fn((n: number) => {
		calls.limit = n;
		return { maybeSingle, returns };
	});
	const chain: Record<string, unknown> = { limit, maybeSingle, returns };
	const order = vi.fn((col: string, opts: unknown) => {
		calls.orders.push([col, opts]);
		return chain;
	});
	chain.order = order;
	const select = vi.fn(() => chain);
	return { client: { from: vi.fn(() => ({ select })) }, calls };
}

beforeEach(() => vi.clearAllMocks());

async function signedIn(db: unknown, user: { id: string } | null = { id: "u1" }) {
	const { createServerSupabaseClient, getUser } = await import("@/lib/auth/server");
	vi.mocked(getUser).mockResolvedValue(user as never);
	vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
}

describe("currentVendor", () => {
	it("returns the vendor the signed-in user belongs to", async () => {
		const { client } = mockDb({ vendors: VENDOR });
		await signedIn(client);
		expect(await currentVendor()).toEqual(VENDOR);
	});

	it("shows the vendor last switched to, and falls back to the oldest", async () => {
		// Both terms matter. With no order at all, limit(1) is whichever row
		// Postgres happens to return and can differ between requests — the
		// dashboard would change under the user, key and install snippet
		// included. Without the created_at fallback, a user who has never
		// touched the switcher would have no vendor at all.
		const { client, calls } = mockDb({ vendors: VENDOR });
		await signedIn(client);
		await currentVendor();
		expect(calls.orders).toEqual([
			["last_selected_at", { ascending: false, nullsFirst: false }],
			["created_at", { ascending: true }],
		]);
		expect(calls.limit).toBe(1);
	});

	it("returns null when signed out, without querying", async () => {
		const { client } = mockDb(null);
		await signedIn(client, null);
		expect(await currentVendor()).toBeNull();
		expect(client.from).not.toHaveBeenCalled();
	});

	it("returns null for a signed-in user with no membership", async () => {
		// The pre-onboarding state. Callers must treat this as "no vendor",
		// not as an error.
		const { client } = mockDb(null);
		await signedIn(client);
		expect(await currentVendor()).toBeNull();
	});

	it("survives a membership row whose vendor join came back empty", async () => {
		const { client } = mockDb({ vendors: null });
		await signedIn(client);
		expect(await currentVendor()).toBeNull();
	});
});

describe("vendorMemberships", () => {
	it("lists in the same order currentVendor resolves, so the first entry is the active one", async () => {
		const { client, calls } = mockDb([]);
		await signedIn(client);
		await vendorMemberships();
		expect(calls.orders).toEqual([
			["last_selected_at", { ascending: false, nullsFirst: false }],
			["created_at", { ascending: true }],
		]);
		// Deliberately unlimited: the switcher needs all of them.
		expect(calls.limit).toBeUndefined();
	});

	it("returns every vendor, unlike currentVendor", async () => {
		// The consent screen must ask rather than assume: a CLI token is minted
		// for exactly one vendor, so silently picking would hand the terminal a
		// credential for a vendor the user did not choose.
		const { client } = mockDb([
			{ vendors: { id: "v1", name: "Acme", slug: "acme", domain: "acme.com" } },
			{ vendors: { id: "v2", name: "Globex", slug: "globex", domain: "globex.com" } },
		]);
		await signedIn(client);
		expect(await vendorMemberships()).toEqual([
			{ id: "v1", name: "Acme", slug: "acme", domain: "acme.com" },
			{ id: "v2", name: "Globex", slug: "globex", domain: "globex.com" },
		]);
	});

	it("drops rows whose join came back empty rather than emitting nulls", async () => {
		const { client } = mockDb([{ vendors: null }, { vendors: { id: "v2", name: "Globex", slug: "globex", domain: "globex.com" } }]);
		await signedIn(client);
		expect(await vendorMemberships()).toEqual([
			{ id: "v2", name: "Globex", slug: "globex", domain: "globex.com" },
		]);
	});

	it("returns nothing when signed out", async () => {
		const { client } = mockDb([]);
		await signedIn(client, null);
		expect(await vendorMemberships()).toEqual([]);
	});
});
