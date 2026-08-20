import { describe, expect, it, vi } from "vitest";
import { CANARY_VENDOR_SLUG, checkCollectorHealth } from "./health";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

describe("checkCollectorHealth", () => {
	it("reports unhealthy without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(checkCollectorHealth()).resolves.toEqual({
			ok: false,
			detail: expect.stringContaining("no datastore configured"),
		});
	});

	it("inserts and cleans up a marked canary row, reporting healthy", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const del = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
		const single = vi.fn().mockResolvedValue({ data: { id: 42 }, error: null });
		const select = vi.fn().mockReturnValue({ single });
		const insert = vi.fn().mockReturnValue({ select });
		const from = vi.fn((table: string) => (table === "hot_events" ? { insert, delete: del } : undefined));
		vi.mocked(dbClient).mockReturnValue({ from } as never);

		await expect(checkCollectorHealth()).resolves.toEqual({ ok: true, detail: "insert + cleanup succeeded" });

		expect(insert).toHaveBeenCalledWith(expect.objectContaining({ vendor_slug: CANARY_VENDOR_SLUG }));
		expect(del).toHaveBeenCalled();
	});

	it("reports unhealthy when the insert itself fails — the exact case record.ts swallows", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const single = vi.fn().mockResolvedValue({ data: null, error: { message: "insert boom" } });
		const select = vi.fn().mockReturnValue({ single });
		const insert = vi.fn().mockReturnValue({ select });
		const from = vi.fn().mockReturnValue({ insert, delete: vi.fn() });
		vi.mocked(dbClient).mockReturnValue({ from } as never);

		await expect(checkCollectorHealth()).resolves.toEqual({
			ok: false,
			detail: expect.stringContaining("insert boom"),
		});
	});

	it("stays healthy even if cleanup of the canary row fails", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const del = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: { message: "delete boom" } }) });
		const single = vi.fn().mockResolvedValue({ data: { id: 7 }, error: null });
		const select = vi.fn().mockReturnValue({ single });
		const insert = vi.fn().mockReturnValue({ select });
		const from = vi.fn().mockReturnValue({ insert, delete: del });
		vi.mocked(dbClient).mockReturnValue({ from } as never);

		await expect(checkCollectorHealth()).resolves.toEqual({ ok: true, detail: "insert + cleanup succeeded" });
	});
});
