import { describe, expect, it, vi } from "vitest";
import { rollupAgenticReads, pruneAgenticReadEvents } from "./agentic-reads";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

describe("rollupAgenticReads", () => {
	it("reports failure without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(rollupAgenticReads()).resolves.toEqual({ ok: false, detail: "no datastore configured" });
	});

	it("calls the rollup function via rpc", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ error: null });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await expect(rollupAgenticReads()).resolves.toEqual({ ok: true });
		expect(rpc).toHaveBeenCalledWith("rollup_agentic_reads_daily");
	});

	it("surfaces an rpc error rather than throwing", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ error: { message: "boom" } });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await expect(rollupAgenticReads()).resolves.toEqual({ ok: false, detail: "boom" });
	});
});

describe("pruneAgenticReadEvents", () => {
	it("reports failure without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(pruneAgenticReadEvents()).resolves.toEqual({ ok: false, detail: "no datastore configured" });
	});

	it("returns the deleted count from the prune function via rpc", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ data: 42, error: null });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await expect(pruneAgenticReadEvents()).resolves.toEqual({ ok: true, deleted: 42 });
		expect(rpc).toHaveBeenCalledWith("prune_agentic_read_events");
	});

	it("surfaces an rpc error rather than throwing", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await expect(pruneAgenticReadEvents()).resolves.toEqual({ ok: false, detail: "boom" });
	});
});
