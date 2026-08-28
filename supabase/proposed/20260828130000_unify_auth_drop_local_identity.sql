-- Auth unification, step 2 (DESTRUCTIVE): remove Letterprove's local identity.
--
-- ⚠️ NOT APPLIED YET — pending review. This is the migration that makes
-- "Letterprove holds no identity of its own" true in the schema. It is the
-- irreversible half of the consolidation (step 1 was the additive
-- 20260825060000_vendor_letterstory_org.sql). After it:
--   • membership lives ONLY in Letterstory (organization_users), derived per
--     request through the /api/letterprove/membership + service-secret seam;
--   • vendors/vendor_customers are reached ONLY through the service-role client
--     (dbClient) behind code permission checks — RLS stays ENABLED with NO
--     policies, i.e. deny-all for anon/authenticated, service_role bypasses;
--   • the Letterprove OAuth 2.1 server (the `letterprove` CLI) is RETIRED,
--     because it authenticated a browser session -> LP auth.users -> vendor_members,
--     and all three are going away. A vendor CLI, if wanted post-launch, is
--     re-added on Letterstory identity, not rebuilt on this dead foundation.
--
-- Pairs with deleting the LP dashboard / login / OAuth routes (see the change
-- manifest in the PR) and turning OFF Letterprove's Supabase Auth (GoTrue) in
-- project config — that last step is a dashboard/config action, not SQL.

-- ---------------------------------------------------------------------------
-- 1. Retire the OAuth 2.1 server. CASCADE also removes their RLS policies
--    (including the three that join through vendor_members) and any FKs.
-- ---------------------------------------------------------------------------
drop table if exists oauth_access_tokens cascade;
drop table if exists oauth_refresh_tokens cascade;
drop table if exists oauth_authorization_codes cascade;
drop table if exists oauth_pending_requests cascade;
drop table if exists oauth_authorizations cascade;
drop table if exists oauth_rate_limits cascade;
drop table if exists oauth_clients cascade;

-- ---------------------------------------------------------------------------
-- 2. Drop every remaining RLS policy on the surviving business tables. They
--    were all keyed on auth.uid()/vendor_members (a user-session concept that
--    no longer exists). RLS stays ENABLED so the tables deny anon/authenticated
--    by default; the service-role client (dbClient) bypasses RLS and is the
--    only path in — dropping policies by name would risk missing one, so sweep.
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
	for p in
		select policyname, tablename
		from pg_policies
		where schemaname = 'public' and tablename in ('vendors', 'vendor_customers')
	loop
		execute format('drop policy if exists %I on %I', p.policyname, p.tablename);
	end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Drop vendor_members — membership is Letterstory's now (organization_users).
--    Its own policies go with it. Nothing FKs into it.
-- ---------------------------------------------------------------------------
drop table if exists vendor_members cascade;

-- ---------------------------------------------------------------------------
-- 4. Tighten the org link to 1:1-required. Per the 20260825060000 migration's
--    own note: "the day standalone Letterprove signup is removed, make this NOT
--    NULL and DELETE the org-less rows rather than backfilling." That day is
--    now. Org-less vendors are the seed fixtures (vantage, lettertrace) and any
--    left by the retired /vendor/onboarding path — none are production data.
-- ---------------------------------------------------------------------------
delete from vendors where letterstory_org_id is null;

alter table vendors
	alter column letterstory_org_id set not null;
