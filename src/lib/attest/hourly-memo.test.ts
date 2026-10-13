import { afterEach, describe, expect, it, vi } from "vitest";
import { createHourlyMemo } from "./hourly-memo";

afterEach(() => vi.useRealTimers());

describe("createHourlyMemo", () => {
	it("holds a complete value for the rest of its key", async () => {
		vi.useFakeTimers();
		const memo = createHourlyMemo<{ complete: boolean }>((v) => v.complete);
		const load = vi.fn(async () => ({ complete: true }));
		await memo("k", load);
		vi.advanceTimersByTime(30 * 60_000);
		await memo("k", load);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("reloads a pending value after a minute, so a new freeze is picked up", async () => {
		vi.useFakeTimers();
		const memo = createHourlyMemo<{ complete: boolean }>((v) => v.complete);
		const load = vi.fn(async () => ({ complete: false }));
		await memo("k", load);
		vi.advanceTimersByTime(30_000);
		await memo("k", load);
		expect(load).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(31_000);
		await memo("k", load);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("evicts a rejected load so the next call retries", async () => {
		const memo = createHourlyMemo<{ complete: boolean }>((v) => v.complete);
		const load = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ complete: true });
		await expect(memo("k", load)).rejects.toThrow("boom");
		await expect(memo("k", load)).resolves.toEqual({ complete: true });
		expect(load).toHaveBeenCalledTimes(2);
	});
});
