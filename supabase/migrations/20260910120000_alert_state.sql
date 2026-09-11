-- Give sendAlert a memory, so a condition that stays broken stops paging every
-- run.
--
-- The gap this closes: src/lib/alerts/notify.ts had no state anywhere, so every
-- failing cron run produced a fresh page. The collector-health watchdog runs
-- every 15 minutes, which means one broken collector is 96 identical Slack
-- lines a day. That is worse than the silence it replaced: a channel people
-- have learned to scroll past reports nothing, and the next real alert arrives
-- into a room that has already stopped looking.
--
-- Keyed on the alert SUBJECT rather than subject+detail, because the subject is
-- the thing that identifies the condition and the detail is the thing that
-- changes between occurrences. "hourly freeze failed: vendor aggregates" is one
-- condition whether it died on vendor 3 or vendor 40; keying on the detail too
-- would defeat suppression exactly when a flapping error message makes the
-- channel loudest. The alert subjects already name their scope for this to work:
-- each one carries the vendor, half, or check it belongs to.
--
-- One row per condition, overwritten in place. This is operational state, not
-- an audit trail: the console.error line in notify.ts is emitted on EVERY
-- occurrence regardless of suppression, so Vercel's Runtime Logs keep the full
-- history and nothing here has to.
--
-- RLS on with NO policies, the same posture as vendor_stripe_credentials and
-- hot_events: only the service role, which bypasses RLS, reads or writes this.
-- No session-bound client has any reason to see it, and a table nothing reads
-- by accident is easier to keep that way.
create table if not exists alert_state (
	-- The subject passed to sendAlert(), verbatim. Text rather than a hash so a
	-- human debugging the suppression can read this table and recognise the
	-- Slack lines they have been getting.
	subject text primary key,

	-- When this run of failures started. Reset when a resolved condition
	-- recurs, so a re-page can say how long the CURRENT incident has been going
	-- rather than when the condition was first ever seen, which is a different
	-- and much less useful number.
	first_seen_at timestamptz not null default now(),

	-- The last time sendAlert() was called for this subject, whether or not it
	-- paged. This is what distinguishes "still failing" from "failed, resolved,
	-- and came back": a gap here longer than the slowest caller's own interval
	-- means nothing reported this condition for a while, which is the only
	-- evidence available that it had stopped. See RECURRENCE_AFTER_MS in
	-- src/lib/alerts/state.ts.
	last_seen_at timestamptz not null default now(),

	-- The last time a page actually went out. Drives the repeat window.
	last_sent_at timestamptz not null default now(),

	-- How many times the condition has been reported in this incident. Carried
	-- into the re-page line, which turns a suppressed window into information
	-- ("still failing, 24 occurrences since 02:14") rather than lost data.
	occurrences integer not null default 1
);

alter table alert_state enable row level security;

comment on table alert_state is
	'One row per alert subject: when its incident started, when it was last reported, and when it last paged. Read and written only by sendAlert() (src/lib/alerts/notify.ts) through the service role. Operational state, not history: every occurrence is logged regardless.';
comment on column alert_state.last_seen_at is
	'Last sendAlert() call for this subject, paged or suppressed. A long gap is how a resolved-then-recurring condition is told apart from one that never stopped failing.';
comment on column alert_state.last_sent_at is
	'Last page actually delivered. A still-failing condition re-pages only once the repeat window has elapsed.';
