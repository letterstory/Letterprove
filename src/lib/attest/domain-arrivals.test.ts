import { describe, expect, it, vi } from "vitest";
import { domainArrivals } from "./domain-arrivals";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/** Mimics the supabase-js chain domainArrivals builds, resolving on .order(). */
function mockDb(result: { data?: unknown; error?: { message: string } }) {
	const chain = {
		select: () => chain,
		eq: () => chain,
		order: () => Promise.resolve({ data: null, error: null, ...result }),
	};
	return { from: () => chain };
}

async function withDb(result: Parameters<typeof mockDb>[0]) {
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(mockDb(result) as never);
	return domainArrivals("vantage");
}

describe("domainArrivals", () => {
	it("returns an empty shape when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		expect(await domainArrivals("vantage")).toEqual({ vendor_first_seen: null, first_seen: [] });
	});

	it("keeps the EARLIEST timestamp per domain, not the latest", async () => {
		// The whole signal depends on this. Taking a later row would make a
		// long-standing customer look newly arrived every time it reappears.
		const result = await withDb({
			data: [
				{ domain: "acme.com", window_start: "2026-08-01T00:00:00.000Z" },
				{ domain: "globex.com", window_start: "2026-08-02T00:00:00.000Z" },
				{ domain: "acme.com", window_start: "2026-08-09T00:00:00.000Z" },
			],
		});

		expect(result.first_seen).toEqual(["2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"]);
	});

	it("reports the vendor's own first observation separately", async () => {
		// A fresh install discovers many domains at once and that is legitimate,
		// so the scorer has to be able to place the clump against the vendor's
		// own start rather than judging it in isolation.
		const result = await withDb({
			data: [
				{ domain: "acme.com", window_start: "2026-08-01T00:00:00.000Z" },
				{ domain: "globex.com", window_start: "2026-08-01T00:30:00.000Z" },
			],
		});

		expect(result.vendor_first_seen).toBe("2026-08-01T00:00:00.000Z");
	});

	it("never leaks domain names — timestamps only", async () => {
		const result = await withDb({
			data: [{ domain: "confidential-customer.com", window_start: "2026-08-01T00:00:00.000Z" }],
		});

		expect(JSON.stringify(result)).not.toContain("confidential-customer");
	});

	it("returns arrivals in ascending order", async () => {
		const result = await withDb({
			data: [
				{ domain: "c.com", window_start: "2026-08-03T00:00:00.000Z" },
				{ domain: "a.com", window_start: "2026-08-01T00:00:00.000Z" },
				{ domain: "b.com", window_start: "2026-08-02T00:00:00.000Z" },
			],
		});

		expect(result.first_seen).toEqual([...result.first_seen].sort());
	});

	it("fails to an empty shape rather than throwing when the query errors", async () => {
		// An absent signal must score as "nothing to say", never as innocence.
		const result = await withDb({ error: { message: "boom" } });

		expect(result).toEqual({ vendor_first_seen: null, first_seen: [] });
	});

	it("handles a vendor with no rollups at all", async () => {
		expect(await withDb({ data: [] })).toEqual({ vendor_first_seen: null, first_seen: [] });
	});
});
