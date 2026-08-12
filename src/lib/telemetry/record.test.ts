import { describe, expect, it, vi } from "vitest";
import { recordObservation } from "./record";

const PARAMS = {
	vendor: "vantage",
	domain: "acme.com",
	ev: "session" as const,
	cfg: 1,
	origin: "vantage.example",
};

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

describe("recordObservation", () => {
	it("no-ops without throwing when no datastore is configured", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue(null);

		await expect(recordObservation(PARAMS)).resolves.toBeUndefined();
	});

	it("inserts a row shaped by the event, not the client's raw payload", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn().mockResolvedValue({ error: null });
		const from = vi.fn().mockReturnValue({ insert });
		vi.mocked(dbClient).mockReturnValue({ from } as never);

		await recordObservation(PARAMS);

		expect(from).toHaveBeenCalledWith("hot_events");
		expect(insert).toHaveBeenCalledWith({
			vendor_slug: "vantage",
			domain: "acme.com",
			ev: "session",
			cfg: 1,
			origin: "vantage.example",
		});
	});

	it("swallows an insert error rather than throwing — telemetry must never break the collector", async () => {
		const { dbClient } = await import("@/lib/db/client");
		const insert = vi.fn().mockResolvedValue({ error: { message: "boom" } });
		vi.mocked(dbClient).mockReturnValue({ from: () => ({ insert }) } as never);

		await expect(recordObservation(PARAMS)).resolves.toBeUndefined();
	});

	it("swallows a thrown rejection rather than propagating it", async () => {
		const { dbClient } = await import("@/lib/db/client");
		vi.mocked(dbClient).mockReturnValue({
			from: () => ({ insert: () => Promise.reject(new Error("network down")) }),
		} as never);

		await expect(recordObservation(PARAMS)).resolves.toBeUndefined();
	});
});
