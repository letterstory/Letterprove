/**
 * Whether an alert should actually page, or has already said this recently.
 *
 * PR #131 made failures visible and stopped there, because suppression needs
 * state and the repo had nowhere to put it. The result is that a condition
 * which stays broken pages on every run: 96 identical lines a day from the
 * 15 minute collector-health watchdog, 24 from each hourly cron. People learn
 * to scroll past a channel that does that, and a channel nobody reads is the
 * silence #131 was written to end, reached the long way round.
 *
 * Three rules, in the order they are checked:
 *
 *   1. No state at all means page. A first occurrence is always news, and so
 *      is a state read that failed for any reason (see below).
 *   2. A gap since the last report longer than RECURRENCE_AFTER_MS means page.
 *      Nothing reported this condition for a while, which is the only evidence
 *      available that it had stopped, so its return is a new incident rather
 *      than a continuation of the old one.
 *   3. Otherwise page only once REPEAT_AFTER_MS has passed since the last page.
 *
 * FAILS TOWARD TELLING A HUMAN, which is the whole posture of this module. A
 * missing table, an unreachable database, a malformed row: every one of them
 * resolves to "send". Suppression is a convenience and an outage is not, so
 * the bookkeeping breaking must never be able to eat an alert. This is the
 * opposite default from most caches, and deliberately so.
 */

import { dbClient } from "@/lib/db/client";

/**
 * How long a condition that keeps failing stays quiet between pages.
 *
 * Six hours, which is four pages a day for something persistently broken. That
 * is few enough that the channel keeps its meaning and frequent enough that no
 * working day, shift or timezone can miss it: a failure starting at 02:00 is
 * still shouting when somebody opens Slack at 09:00. The alternative shape,
 * paging once and never again, was rejected because a resolved-looking channel
 * is how a broken thing gets forgotten.
 *
 * Nothing is lost in between. notify.ts logs every occurrence to
 * console.error whether it pages or not, so the full history stays in Vercel's
 * Runtime Logs and the re-page line carries the count.
 */
export const REPEAT_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * How long a subject must go unreported before its return counts as a new
 * incident rather than more of the same one.
 *
 * This has a floor it must clear: every caller is a cron, and the slowest of
 * them runs hourly, so consecutive reports of a condition that never stopped
 * failing arrive 60 minutes apart. A recurrence threshold at or below that
 * would read every one of those as a fresh incident and page on all of them,
 * which is the behaviour this module exists to remove. Two hours is twice the
 * floor, which leaves room for a cron that runs late or is retried.
 *
 * The cost of being wrong here is one extra page when a cron genuinely skips
 * a run, and that is the direction to be wrong in.
 *
 * It is deliberately SHORTER than REPEAT_AFTER_MS, which has a consequence
 * worth naming: a caller that reports a condition less often than every two
 * hours never reaches rule 3 at all, because each of its reports looks like a
 * new incident and pages. That is the correct answer for such a caller. With
 * nothing reporting the condition in between, there is no evidence it stayed
 * broken, and inventing that evidence in order to stay quiet would be the one
 * mistake this module must not make. Every caller today is a 15 minute or
 * hourly cron, so all of them sit well inside the window.
 */
export const RECURRENCE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface AlertDecision {
	send: boolean;
	/**
	 * Present when a still-failing condition is being re-reported. Appended to
	 * the alert so a re-page reads as "this has been going on" rather than as a
	 * brand new failure, which is the difference between one investigation and
	 * two.
	 */
	context?: string;
}

/**
 * Records this occurrence and answers whether it should page.
 *
 * Never throws. Its callers are error paths by definition, and an alerting
 * helper that can crash them turns "tell a human" into a second outage.
 */
export async function shouldSendAlert(subject: string, now = Date.now()): Promise<AlertDecision> {
	const db = dbClient();
	// No datastore configured is the local and preview case. Every alert pages,
	// exactly as it did before this module existed.
	if (!db) return { send: true };

	try {
		const { data, error } = await db
			.from("alert_state")
			.select("first_seen_at, last_seen_at, last_sent_at, occurrences")
			.eq("subject", subject)
			.maybeSingle();

		// Includes the case this is most likely to hit in the wild: the table is
		// not there yet because the migration has not been applied. An unapplied
		// migration must not be able to silence production alerting.
		if (error) {
			console.error("[letterprove:alert] suppression state unreadable, sending anyway", error.message);
			return { send: true };
		}

		const row = data as AlertRow | null;
		const decision = decide(row, now);

		await record(db, subject, row, decision, now);
		return decision;
	} catch (e) {
		// A throw here is not something alerting gets to propagate. Same reason
		// as above, one level out.
		console.error("[letterprove:alert] suppression check failed, sending anyway", e instanceof Error ? e.message : e);
		return { send: true };
	}
}

interface AlertRow {
	first_seen_at: string;
	last_seen_at: string;
	last_sent_at: string;
	occurrences: number;
}

/** The three rules, with no I/O, so they can be read and tested as rules. */
function decide(row: AlertRow | null, now: number): AlertDecision {
	if (!row) return { send: true };

	const lastSeen = Date.parse(row.last_seen_at);
	const lastSent = Date.parse(row.last_sent_at);
	// A row whose timestamps will not parse is corrupt state, and corrupt state
	// must not be able to suppress. Send, and let the write below overwrite it
	// with something readable.
	if (Number.isNaN(lastSeen) || Number.isNaN(lastSent)) return { send: true };

	if (now - lastSeen >= RECURRENCE_AFTER_MS) return { send: true };
	if (now - lastSent < REPEAT_AFTER_MS) return { send: false };

	return { send: true, context: stillFailing(row, now) };
}

/**
 * What the suppressed window contained. A bare repeat of the original line
 * tells a reader nothing about whether this is hour one or hour thirty.
 */
function stillFailing(row: AlertRow, now: number): string {
	// The occurrence being decided is not in the stored count yet.
	const occurrences = row.occurrences + 1;
	const first = Date.parse(row.first_seen_at);
	const hours = Number.isNaN(first) ? null : Math.round((now - first) / (60 * 60 * 1000));
	const since = hours === null ? "" : `, ongoing for ${hours}h`;
	return `still failing${since} (${occurrences} occurrences)`;
}

/**
 * Persists this occurrence. Best effort on purpose: the alert has already been
 * decided, and a failed write costs an extra page next run rather than a
 * missed one.
 *
 * Read-then-write rather than a single atomic statement. Two invocations
 * racing on the same subject can both decide to send, which costs one
 * duplicate alert. That is the safe direction, and cheap enough not to be
 * worth a stored procedure: the callers are crons on 15 and 60 minute
 * schedules, so the overlap it needs is a retry landing on top of a run.
 */
async function record(
	db: NonNullable<ReturnType<typeof dbClient>>,
	subject: string,
	row: AlertRow | null,
	decision: AlertDecision,
	now: number,
): Promise<void> {
	const iso = new Date(now).toISOString();
	// A send that was NOT a plain repeat starts a new incident: no row at all,
	// or a gap long enough that rule 2 fired. Either way the counter and the
	// incident start belong at now, or a re-page six hours from here would
	// report an age measured from a failure that has already been fixed once.
	const newIncident = decision.send && !decision.context;

	const { error } = await db.from("alert_state").upsert(
		{
			subject,
			first_seen_at: newIncident || !row ? iso : row.first_seen_at,
			last_seen_at: iso,
			// An unsent occurrence must not move last_sent_at, or the repeat
			// window would restart on every suppressed call and the alert would
			// never be heard from again.
			last_sent_at: decision.send ? iso : (row?.last_sent_at ?? iso),
			occurrences: newIncident || !row ? 1 : row.occurrences + 1,
		},
		{ onConflict: "subject" },
	);

	if (error) {
		console.error("[letterprove:alert] could not record alert state", error.message);
	}
}
