import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STALE_AFTER_HOURS, checkPublicationFreshness } from "./freshness";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

const HOUR_MS = 3600 * 1000;
const NOW = Date.UTC(2026, 8, 9, 14, 30);
const CURRENT_BUCKET = Math.floor(NOW / HOUR_MS);

/**
 * Each table gets its own newest-row answer, because the whole point of
 * checking them separately is that one half can stall while the other keeps
 * publishing.
 */
function mockDb(byTable: Record<string, { bucket?: number | null; error?: string }>) {
	const from = vi.fn((table: string) => {
		const answer = byTable[table] ?? { bucket: null };
		const result = answer.error
			? { data: null, error: { message: answer.error } }
			: { data: answer.bucket == null ? null : { hour_bucket: answer.bucket }, error: null };
		const chain = {
			select: () => chain,
			order: () => chain,
			limit: () => chain,
			maybeSingle: vi.fn().mockResolvedValue(result),
		};
		return chain;
	});
	return { from };
}

async function useDb(db: unknown) {
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(db as never);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("checkPublicationFreshness", () => {
	// The healthy steady state: the freeze ran this hour, or ran last hour and
	// this hour's :05 has not come round yet. Neither may page anyone.
	it.each([0, 1, STALE_AFTER_HOURS - 1])("reports fresh when the newest row is %ih behind", async (behind) => {
		await useDb(
			mockDb({
				published_snapshots: { bucket: CURRENT_BUCKET - behind },
				published_aggregates: { bucket: CURRENT_BUCKET - behind },
			})
		);

		const result = await checkPublicationFreshness();

		expect(result.ok).toBe(true);
		expect(result.checks.every((c) => c.ok)).toBe(true);
	});

	// Two consecutive missed freezes. Every served attestation is now carrying
	// a published_at this old under a one hour ttl, which is the product making
	// a freshness claim it cannot back.
	it("reports stale once the newest row falls past the threshold", async () => {
		await useDb(
			mockDb({
				published_snapshots: { bucket: CURRENT_BUCKET - STALE_AFTER_HOURS },
				published_aggregates: { bucket: CURRENT_BUCKET - STALE_AFTER_HOURS },
			})
		);

		const result = await checkPublicationFreshness();

		expect(result.ok).toBe(false);
		expect(result.checks.filter((c) => !c.ok)).toHaveLength(2);
		expect(result.checks[0].detail).toContain(`${STALE_AFTER_HOURS}h behind`);
	});

	// A combined verdict would have hidden this: the aggregate is publishing
	// fine and only the per-customer half has stalled, which is a different
	// investigation and a different blast radius.
	it("names only the half that has stalled", async () => {
		await useDb(
			mockDb({
				published_snapshots: { bucket: CURRENT_BUCKET - 9 },
				published_aggregates: { bucket: CURRENT_BUCKET },
			})
		);

		const result = await checkPublicationFreshness();

		expect(result.ok).toBe(false);
		const failing = result.checks.filter((c) => !c.ok);
		expect(failing).toHaveLength(1);
		expect(failing[0].scope).toContain("per-customer");
	});

	// A deploy whose vendors have no named customers never writes
	// published_snapshots. Paging about that every 15 minutes forever is the
	// loudest possible way to say nothing.
	it("does not call an unwritten table stale", async () => {
		await useDb(mockDb({ published_snapshots: { bucket: null }, published_aggregates: { bucket: CURRENT_BUCKET } }));

		const result = await checkPublicationFreshness();

		expect(result.ok).toBe(true);
		expect(result.checks[0].detail).toContain("never been written");
	});

	// Not knowing whether the record is stale is itself worth telling someone,
	// but it must not masquerade as a staleness finding.
	it("reports a failed read as uncheckable rather than as staleness", async () => {
		await useDb(
			mockDb({ published_snapshots: { error: "connection reset" }, published_aggregates: { bucket: CURRENT_BUCKET } })
		);

		const result = await checkPublicationFreshness();

		expect(result.ok).toBe(false);
		expect(result.checks[0].detail).toContain("cannot read published_snapshots");
		expect(result.checks[0].detail).toContain("connection reset");
	});

	it("reports failure without throwing when no datastore is configured", async () => {
		await useDb(null);

		const result = await checkPublicationFreshness();

		expect(result.ok).toBe(false);
		expect(result.checks[0].detail).toContain("no datastore configured");
	});
});
