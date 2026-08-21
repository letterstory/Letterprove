import { describe, expect, it, vi } from "vitest";
import { recordConfigPing } from "./ping";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

describe("recordConfigPing", () => {
	it("no-ops without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(recordConfigPing("vantage")).resolves.toBeUndefined();
	});

	it("delegates the upsert — and the timestamp — to the database", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ error: null });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await recordConfigPing("vantage");

		expect(rpc).toHaveBeenCalledWith("record_config_ping", { slug: "vantage" });
	});

	it("sends no timestamp of its own — two clocks stamping one row is the bug this fixes", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ error: null });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await recordConfigPing("vantage");

		// Guards the regression directly: any client-side time reintroduces the
		// skew that put last_seen before first_seen in production.
		const [, params] = rpc.mock.calls[0];
		expect(Object.keys(params)).toEqual(["slug"]);
	});

	it("swallows an rpc error rather than throwing — telemetry must never break config delivery", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockResolvedValue({ error: { message: "boom" } });
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await expect(recordConfigPing("vantage")).resolves.toBeUndefined();
	});

	it("swallows a thrown rpc for the same reason", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const rpc = vi.fn().mockRejectedValue(new Error("network"));
		vi.mocked(dbClient).mockReturnValue({ rpc } as never);

		await expect(recordConfigPing("vantage")).resolves.toBeUndefined();
	});
});
