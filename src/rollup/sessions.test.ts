import { describe, expect, it, vi } from "vitest";
import { rollupHotEvents } from "./sessions";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

describe("rollupHotEvents", () => {
	it("reports failure without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(rollupHotEvents()).resolves.toEqual({ ok: false, detail: "no datastore configured" });
	});

	it("calls the rollup function via rpc", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ error: null });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await expect(rollupHotEvents()).resolves.toEqual({ ok: true });
		expect(rpc).toHaveBeenCalledWith("rollup_hot_events_hourly");
	});

	it("surfaces an rpc error rather than throwing", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ error: { message: "boom" } });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await expect(rollupHotEvents()).resolves.toEqual({ ok: false, detail: "boom" });
	});
});
