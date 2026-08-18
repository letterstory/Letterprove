import { beforeEach, describe, expect, it, vi } from "vitest";
import { getVendorStatus } from "./status";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

function mockDb({ vendor, count, error }: { vendor: unknown; count?: number | null; error?: unknown }) {
	const vendorMaybeSingle = vi.fn().mockResolvedValue({ data: vendor });
	const vendorEq = vi.fn().mockReturnValue({ maybeSingle: vendorMaybeSingle });
	const vendorSelect = vi.fn().mockReturnValue({ eq: vendorEq });

	const eventsGte = vi.fn().mockResolvedValue({ count: count ?? null, error: error ?? null });
	const eventsEq = vi.fn().mockReturnValue({ gte: eventsGte });
	const eventsSelect = vi.fn().mockReturnValue({ eq: eventsEq });

	const from = vi.fn((table: string) => (table === "vendors" ? { select: vendorSelect } : { select: eventsSelect }));
	return { from };
}

beforeEach(() => vi.clearAllMocks());

describe("getVendorStatus", () => {
	it("reports not configured rather than throwing when there's no service-role client", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		expect(await getVendorStatus("v1")).toEqual({ ok: false, status: 404, error: "Not configured" });
	});

	it("reports not configured when the vendor id doesn't resolve to a vendor", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ vendor: null }) as never);

		expect(await getVendorStatus("v1")).toEqual({ ok: false, status: 404, error: "Not configured" });
	});

	it("reports receiving=false with a zero count when nothing landed in the window", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ vendor: { slug: "acme" }, count: 0 }) as never);

		expect(await getVendorStatus("v1")).toEqual({ ok: true, receiving: false, count: 0 });
	});

	it("reports receiving=true once at least one event landed", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ vendor: { slug: "acme" }, count: 5 }) as never);

		expect(await getVendorStatus("v1")).toEqual({ ok: true, receiving: true, count: 5 });
	});

	it("reports a count failure distinctly from a missing vendor", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(mockDb({ vendor: { slug: "acme" }, error: new Error("boom") }) as never);

		expect(await getVendorStatus("v1")).toEqual({ ok: false, status: 500, error: "Count failed" });
	});
});
