-- Frozen attestation rows are insert-only.
--
-- Since this change the proof routes serve ONLY rows the hourly freeze has
-- written (src/lib/attest/proofs.ts, src/lib/attest/aggregate.ts), so a row
-- that exists has been handed out, and the `verify` link inside it has to keep
-- resolving to exactly those bytes. The freezes skip an hour that is already
-- frozen and write with ON CONFLICT DO NOTHING; this trigger is the backstop
-- that makes overwriting a published row impossible rather than merely avoided.
--
-- UPDATE only. DELETE stays possible for retention and for removing a vendor's
-- data at their request; a deleted row is a visible gap, not a silent rewrite.
--
-- Safe against the code deployed before this change: its freeze upserts once
-- per hour at :05, and a first write for an hour is a plain INSERT that never
-- reaches the UPDATE branch.

create or replace function refuse_published_row_update() returns trigger
language plpgsql as $$
begin
	raise exception '% rows are immutable once frozen (vendor %, hour %)',
		tg_table_name, old.vendor_slug, old.hour_bucket;
end;
$$;

drop trigger if exists published_snapshots_insert_only on published_snapshots;
create trigger published_snapshots_insert_only
	before update on published_snapshots
	for each row execute function refuse_published_row_update();

drop trigger if exists published_aggregates_insert_only on published_aggregates;
create trigger published_aggregates_insert_only
	before update on published_aggregates
	for each row execute function refuse_published_row_update();
