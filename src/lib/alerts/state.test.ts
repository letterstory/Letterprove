import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

import { dbClient } from "@/lib/db/client";
import { REPEAT_AFTER_MS, RECURRENCE_AFTER_MS, shouldSendAlert } from "./state";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const SUBJECT = "collector health check failed";

interface Row {
	first_seen_at: string;
	last_seen_at: string;
	last_sent_at: string;
	occurrences: number;
}

/**
 * Answers the one read and captures the one write. Deliberately not a general
 * PostgREST mock: this module touches exactly one table with exactly one
 * select and one upsert, and a mock any wider would be describing a query
 * nothing makes.
 */
function mockDb(row: Row | null, options: { selectError?: string; upsertError?: string } = {}) {
	const upserts: Record<string, unknown>[] = [];
	const db = {
		from: () => ({
			select: () => ({
				eq: () => ({
					maybeSingle: async () => ({
						data: options.selectError ? null : row,
						error: options.selectError ? { message: options.selectError } : null,
					}),
				}),
			}),
			upsert: async (values: Record<string, unknown>) => {
				upserts.push(values);
				return { error: options.upsertError ? { message: options.upsertError } : null };
			},
		}),
	};
	vi.mocked(dbClient).mockReturnValue(db as never);
	return upserts;
}

function row(over: Partial<Row> & { agoMs?: number } = {}): Row {
	const ago = over.agoMs ?? 0;
	const stamp = new Date(NOW - ago).toISOString();
	return {
		first_seen_at: stamp,
		last_seen_at: stamp,
		last_sent_at: stamp,
		occurrences: 1,
		...over,
	};
}

describe("shouldSendAlert", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it("sends the first occurrence of a subject and starts an incident", async () => {
		const upserts = mockDb(null);

		expect(await shouldSendAlert(SUBJECT, NOW)).toEqual({ send: true });
		expect(upserts[0]).toMatchObject({ subject: SUBJECT, occurrences: 1 });
	});

	// The behaviour the whole table exists for: the 15 minute watchdog reporting
	// the same broken collector must not produce 96 pages a day.
	it("suppresses a repeat inside the window and does not move last_sent_at", async () => {
		const sentAt = new Date(NOW - 60 * 60 * 1000).toISOString();
		const upserts = mockDb(row({ agoMs: 15 * 60 * 1000, last_sent_at: sentAt, occurrences: 4 }));

		expect(await shouldSendAlert(SUBJECT, NOW)).toEqual({ send: false });
		// Moving it would restart the repeat window on every suppressed call, and
		// the alert would never be heard from again.
		expect(upserts[0].last_sent_at).toBe(sentAt);
		expect(upserts[0].occurrences).toBe(5);
	});

	it("pages again once the repeat window has elapsed, and says how long it has been going", async () => {
		const upserts = mockDb(
			row({
				agoMs: 15 * 60 * 1000,
				first_seen_at: new Date(NOW - 8 * 60 * 60 * 1000).toISOString(),
				last_sent_at: new Date(NOW - REPEAT_AFTER_MS - 1000).toISOString(),
				occurrences: 30,
			}),
		);

		const decision = await shouldSendAlert(SUBJECT, NOW);

		expect(decision.send).toBe(true);
		expect(decision.context).toContain("still failing");
		expect(decision.context).toContain("8h");
		expect(decision.context).toContain("31 occurrences");
		// Still the same incident, so the count keeps climbing rather than resetting.
		expect(upserts[0].occurrences).toBe(31);
	});

	// A condition that stopped and came back is news again, even though its last
	// page was recent. Without this, a failure that resolves and recurs an hour
	// later stays suppressed for the rest of the repeat window.
	it("pages a recurrence after a quiet gap, even inside the repeat window", async () => {
		const upserts = mockDb(
			row({
				agoMs: RECURRENCE_AFTER_MS + 1000,
				last_sent_at: new Date(NOW - RECURRENCE_AFTER_MS - 1000).toISOString(),
				occurrences: 12,
			}),
		);

		const decision = await shouldSendAlert(SUBJECT, NOW);

		expect(decision.send).toBe(true);
		// A new incident, so the age a later re-page reports is measured from now
		// rather than from a failure that was already fixed once.
		expect(decision.context).toBeUndefined();
		expect(upserts[0].occurrences).toBe(1);
		expect(upserts[0].first_seen_at).toBe(new Date(NOW).toISOString());
	});

	// The floor RECURRENCE_AFTER_MS has to clear: the slowest caller is an
	// hourly cron, so an unbroken failure reports once an hour. If that read as
	// a recurrence, suppression would never happen at all.
	it("treats hourly reports of an unresolved condition as the same incident", async () => {
		mockDb(
			row({
				agoMs: 60 * 60 * 1000,
				last_sent_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
				occurrences: 3,
			}),
		);

		expect((await shouldSendAlert(SUBJECT, NOW)).send).toBe(false);
	});

	describe("fails toward telling a human", () => {
		it("sends when there is no datastore at all", async () => {
			vi.mocked(dbClient).mockReturnValue(null);

			expect(await shouldSendAlert(SUBJECT, NOW)).toEqual({ send: true });
		});

		// The likeliest real failure: the migration has not been applied yet. An
		// unapplied migration must not be able to silence production alerting.
		it("sends when the state table cannot be read", async () => {
			mockDb(null, { selectError: 'relation "alert_state" does not exist' });

			expect(await shouldSendAlert(SUBJECT, NOW)).toEqual({ send: true });
		});

		it("sends when a stored row has unparseable timestamps", async () => {
			mockDb({ first_seen_at: "nonsense", last_seen_at: "nonsense", last_sent_at: "nonsense", occurrences: 2 });

			expect((await shouldSendAlert(SUBJECT, NOW)).send).toBe(true);
		});

		it("sends when the read throws outright", async () => {
			vi.mocked(dbClient).mockReturnValue({
				from: () => {
					throw new Error("connection reset");
				},
			} as never);

			expect(await shouldSendAlert(SUBJECT, NOW)).toEqual({ send: true });
		});

		// The decision is already made by the time the write happens, so a failed
		// write costs an extra page next run rather than a missed one.
		it("still sends when recording the occurrence fails", async () => {
			mockDb(null, { upsertError: "write failed" });

			expect((await shouldSendAlert(SUBJECT, NOW)).send).toBe(true);
		});
	});

	it("never throws, whatever the datastore does", async () => {
		vi.mocked(dbClient).mockReturnValue({
			from: () => ({
				select: () => ({ eq: () => ({ maybeSingle: () => Promise.reject(new Error("boom")) }) }),
			}),
		} as never);

		await expect(shouldSendAlert(SUBJECT, NOW)).resolves.toEqual({ send: true });
	});
});
