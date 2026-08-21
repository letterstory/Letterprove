-- Which vendor a user is currently looking at.
--
-- currentVendor() takes the OLDEST membership, which was fine while a user
-- could only ever have one. It also made a second vendor invisible: whichever
-- one you created later could not be reached from anywhere in the app, so
-- 20260820 (#72) had to redirect members away from /vendor/onboarding purely
-- to stop people making vendors that vanished. That redirect was a workaround
-- for this missing column.
--
-- Stored as a timestamp on the membership row rather than an `active` boolean
-- or an `active_vendor_id` on a per-user table. Two reasons:
--
--   1. A boolean needs an invariant — exactly one true per user — that nothing
--      in the database enforces, so it can drift into "two actives" or "none"
--      and there is no right answer when it does. An ordering cannot drift:
--      whatever the values, exactly one row sorts first.
--   2. It degrades to the current behaviour instead of replacing it. With
--      nothing ever selected every row is null, the sort falls through to
--      created_at, and the oldest membership wins — which is exactly what
--      happens today. No backfill, and no flag day.
--
-- The sibling product (lettertrace) keeps this on `profiles.active_project_id`.
-- That shape is right there, where a profiles table already exists to hang it
-- on; here it would mean a new table and a new RLS surface to carry one
-- nullable value.

alter table if exists vendor_members
	add column if not exists last_selected_at timestamptz;

comment on column vendor_members.last_selected_at is
	'When this user last switched to this vendor. Ordering, not a flag — currentVendor() sorts by it descending and falls back to created_at, so null everywhere means "oldest membership", the pre-switcher behaviour.';

-- Switching writes to the caller's own membership row and nothing else. The
-- table already had select and insert policies scoped to auth.uid(); this is
-- the same scope for update, so a user still cannot see, create, or now touch
-- a membership that is not theirs.
-- Dropped first because `create policy` has no `if not exists` — unlike every
-- other statement in this file, it cannot be re-run. That is not hypothetical:
-- this migration was applied by hand while testing the switcher, and the
-- deploy that followed re-ran it and failed the whole build on SQLSTATE 42710.
-- A migration that only works against a database in one exact state is a trap
-- for whoever re-runs it next, restores a branch, or seeds an environment.
drop policy if exists "a user can update their own membership" on vendor_members;

create policy "a user can update their own membership" on vendor_members
	for update
	using (user_id = auth.uid())
	with check (user_id = auth.uid());
