-- ----------------------------------------------------------------------------
-- Allow OAuth grants with no vendor at all — a staff-only login.
-- ----------------------------------------------------------------------------
-- oauth_authorizations/access_tokens/refresh_tokens were built vendor-first
-- (see 20260818200000_oauth_authorization_server.sql) with vendor_id not null.
-- staff:* capabilities (added alongside this migration in scopes.ts) are not
-- scoped to any vendor, so a token minted for a pure-staff grant has no
-- vendor_id to put there. oauth_pending_requests already allowed a null
-- vendor_id for exactly this reason; this migration catches the three
-- downstream tables up to it.
--
-- The existing "vendor members can read their own X" policies stay as-is —
-- they simply never match a null-vendor row. A companion policy is added so
-- the signed-in user who holds the grant can still read their own staff-only
-- rows, joined through authorization_id -> oauth_authorizations.user_id since
-- access/refresh tokens don't carry user_id directly.
alter table oauth_authorizations alter column vendor_id drop not null;
alter table oauth_access_tokens alter column vendor_id drop not null;
alter table oauth_refresh_tokens alter column vendor_id drop not null;

-- The existing unique (client_id, vendor_id, user_id) leaves vendor_id in
-- place unchanged. Standard SQL null semantics mean two null-vendor_id rows
-- never collide as duplicates, so a re-consenting staff user's second login
-- inserts a fresh authorization row rather than updating the first (unlike
-- the vendor-scoped case, which the constraint still dedupes correctly).
-- Accepted for now: staff logins are low-volume internal actions, so a few
-- accumulated rows per user are a cosmetic listing issue, not a correctness
-- or security one. Revisit if a "connected apps" screen ever needs to list
-- these 1:1 per user.

create policy "staff can read their own vendor-less oauth authorizations" on oauth_authorizations
	for select
	using (vendor_id is null and user_id = auth.uid());

create policy "staff can read their own vendor-less oauth access tokens" on oauth_access_tokens
	for select
	using (
		vendor_id is null
		and authorization_id in (select id from oauth_authorizations where user_id = auth.uid())
	);

create policy "staff can read their own vendor-less oauth refresh tokens" on oauth_refresh_tokens
	for select
	using (
		vendor_id is null
		and authorization_id in (select id from oauth_authorizations where user_id = auth.uid())
	);
