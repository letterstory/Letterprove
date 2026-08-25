-- Which Letterstory organization a vendor is, so the two products can point at
-- the same customer without merging their databases.
--
-- Settled 2026-08-25 (Steve): Letterprove stays its own service with its own
-- database, shared data moves into shared Letterstory tables, and **a
-- Letterprove vendor IS a Letterstory org** — related, but independently
-- normalised. Until now that last sentence was an assertion with nothing
-- implementing it: there was no column here referencing an org, in any
-- migration, so nothing could actually resolve one to the other.
--
-- NOT a foreign key, and it cannot be one. `organizations` lives in a different
-- Postgres instance entirely, so this is a soft reference the database cannot
-- enforce. Two consequences worth stating rather than discovering:
--
--   1. An org deleted in Letterstory leaves a vendor here pointing at nothing.
--      That is survivable — the vendor keeps working on its own credentials,
--      exactly as it does today — but it will never be cleaned up automatically.
--   2. Nothing stops a wrong uuid being written. Whatever writes this is the
--      only thing that can be sure the org exists, so that check belongs at
--      the seam, not here.
--
-- UNIQUE because the relationship is 1:1. Two vendors claiming the same org
-- would make "which proofs does this workspace publish?" ambiguous, and the
-- honest place to fail that is on write.
--
-- NULLABLE because most vendors have no org and never will: anyone who signed
-- up through Letterprove's own onboarding, plus every vendor that exists today.
-- Backfilling a placeholder would turn "no linked workspace" into a uuid that
-- looks real, which is worse than absent.
alter table vendors
	add column letterstory_org_id uuid;

-- Partial, because the common case is null and a plain unique index would
-- otherwise carry every unlinked vendor for nothing. Postgres treats nulls as
-- distinct in a unique index anyway; the WHERE clause makes that explicit and
-- keeps the index small.
create unique index if not exists vendors_letterstory_org_id_idx
	on vendors (letterstory_org_id)
	where letterstory_org_id is not null;

comment on column vendors.letterstory_org_id is
	'The Letterstory organization this vendor is, 1:1. A soft reference — organizations live in another database, so it cannot be a foreign key and is not cleaned up when an org is deleted.';
