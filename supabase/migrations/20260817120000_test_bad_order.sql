-- OAuth 2.1 authorization server for CLI browser login (RFC 8252 loopback +
-- PKCE). This is step 1 of the CLI: today the app has only browser-cookie
-- Supabase sessions (src/lib/auth/server.ts, src/proxy.ts), which a terminal
-- cannot hold — so there is no way to authenticate a non-browser client at all.
--
-- Letterprove runs its OWN authorization server rather than borrowing
-- Letterstory's: different Supabase project, different user pool, different
-- product. The shape below is ported from that sister implementation, but
-- every credential-bearing table is keyed on `vendor_id` and joined through
-- `vendor_members` so it composes with the RLS model established in
-- 20260814230000_vendor_accounts.sql instead of introducing a second notion
-- of tenancy.
--
-- A CLI login therefore authenticates as "this user, acting for this vendor" —
-- the same pair `vendor_members` already stores.

-- ----------------------------------------------------------------------------
-- PHASE 1: oauth_clients — the registry of apps allowed to request tokens.
-- ----------------------------------------------------------------------------
-- No end-user policy: this is platform config, not tenant data, and is read
-- only through the service-role client (src/lib/db/client.ts), the same trust
-- boundary the collector already uses. RLS is enabled anyway for defense in
-- depth — an empty policy set denies anon and authenticated by default.
create table if not exists oauth_clients (
	id uuid primary key default gen_random_uuid(),
	client_id text unique not null,
	client_secret_hash text,
	name text not null,
	client_type text not null default 'public' check (client_type in ('public', 'confidential')),
	redirect_uris text[] not null,
	allowed_scopes text[] not null,
	is_first_party boolean not null default false,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

alter table oauth_clients enable row level security;

-- The CLI is a public (no client secret) native app per RFC 8252 — it cannot
-- keep a secret, so PKCE (S256) is the only proof of possession. Loopback
-- redirect URIs are stored WITHOUT a port: redirectUriAllowed() in
-- src/lib/oauth/pkce.ts matches scheme+host+path and lets the port float,
-- because the CLI binds a fresh ephemeral port per login attempt.
--
-- allowed_scopes is the '*' sentinel rather than an enumerated list. An
-- enumerated list is a snapshot that goes stale the moment a capability is
-- added, and silently drops it — the sister product shipped that bug and had
-- to migrate out of it. /api/oauth/authorize expands '*' against the CURRENT
-- capabilityValues at request time (see expandScopeWildcard in
-- src/lib/oauth/scopes.ts), so new capabilities need no migration here.
insert into oauth_clients (client_id, name, client_type, redirect_uris, allowed_scopes, is_first_party)
values (
	'letterprove_cli',
	'Letterprove CLI',
	'public',
	array['http://127.0.0.1/callback', 'http://[::1]/callback'],
	array['*'],
	true
)
on conflict (client_id) do nothing;

-- ----------------------------------------------------------------------------
-- PHASE 2: oauth_pending_requests — one row per in-flight /authorize attempt.
-- ----------------------------------------------------------------------------
-- Created (unauthenticated) when GET /authorize validates the request, then
-- claimed by whichever user signs in, then consumed exactly once by the consent
-- POST. The server-generated nonce — not any client-submitted hidden field — is
-- what binds the consent form back to this row, so a forged form post cannot
-- attach someone else's login to a scope it never asked for.
create table if not exists oauth_pending_requests (
	id uuid primary key default gen_random_uuid(),
	nonce text unique not null,
	client_id text not null references oauth_clients (client_id) on delete cascade,
	vendor_id uuid references vendors (id) on delete cascade,
	user_id uuid references auth.users (id) on delete cascade,
	redirect_uri text not null,
	scope text not null,
	state text,
	code_challenge text not null,
	code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
	status text not null default 'pending' check (status in ('pending', 'claimed', 'consumed', 'expired')),
	expires_at timestamptz not null default (now() + interval '10 minutes'),
	created_at timestamptz not null default now()
);

create index if not exists oauth_pending_requests_nonce_idx on oauth_pending_requests (nonce);
alter table oauth_pending_requests enable row level security;

-- ----------------------------------------------------------------------------
-- PHASE 3: oauth_authorizations — durable "vendor X granted client Y scope Z".
-- ----------------------------------------------------------------------------
-- Re-consenting updates the existing row's scope rather than duplicating it,
-- and refresh-token families hang off authorization_id so revoking one
-- authorization (a future "disconnect this app" screen) cascades to its tokens.
create table if not exists oauth_authorizations (
	id uuid primary key default gen_random_uuid(),
	client_id text not null references oauth_clients (client_id) on delete cascade,
	vendor_id uuid not null references vendors (id) on delete cascade,
	user_id uuid not null references auth.users (id) on delete cascade,
	scope text not null,
	revoked_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (client_id, vendor_id, user_id)
);

create index if not exists oauth_authorizations_vendor_idx on oauth_authorizations (vendor_id);
alter table oauth_authorizations enable row level security;

create policy "vendor members can read their own oauth authorizations" on oauth_authorizations
	for select
	using (vendor_id in (select vendor_id from vendor_members where user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- PHASE 4: oauth_authorization_codes — single-use code, /authorize -> /token.
-- ----------------------------------------------------------------------------
-- Not vendor-scoped and deliberately policy-less: a code lives for 60 seconds,
-- is never shown in any dashboard, and reaches the token endpoint through the
-- service-role client only. Its vendor is reachable via authorization_id.
create table if not exists oauth_authorization_codes (
	id uuid primary key default gen_random_uuid(),
	code_hash text unique not null,
	authorization_id uuid not null references oauth_authorizations (id) on delete cascade,
	redirect_uri text not null,
	code_challenge text not null,
	code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
	scope text not null,
	consumed_at timestamptz,
	expires_at timestamptz not null default (now() + interval '60 seconds'),
	created_at timestamptz not null default now()
);

create index if not exists oauth_authorization_codes_code_hash_idx on oauth_authorization_codes (code_hash);
alter table oauth_authorization_codes enable row level security;

-- ----------------------------------------------------------------------------
-- PHASE 5: oauth_access_tokens
-- ----------------------------------------------------------------------------
-- Tokens are stored as SHA-256 hashes, never in the clear: reading this table
-- must not be enough to impersonate a CLI session.
create table if not exists oauth_access_tokens (
	id uuid primary key default gen_random_uuid(),
	token_hash text unique not null,
	authorization_id uuid not null references oauth_authorizations (id) on delete cascade,
	vendor_id uuid not null references vendors (id) on delete cascade,
	scope text not null,
	expires_at timestamptz not null,
	revoked_at timestamptz,
	last_used_at timestamptz,
	created_at timestamptz not null default now()
);

create index if not exists oauth_access_tokens_token_hash_idx on oauth_access_tokens (token_hash);
create index if not exists oauth_access_tokens_vendor_idx on oauth_access_tokens (vendor_id);
alter table oauth_access_tokens enable row level security;

create policy "vendor members can read their own oauth access tokens" on oauth_access_tokens
	for select
	using (vendor_id in (select vendor_id from vendor_members where user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- PHASE 6: oauth_refresh_tokens — rotation chain with reuse detection.
-- ----------------------------------------------------------------------------
-- family_id is constant across a whole rotation chain. On detected reuse (a
-- refresh token presented a second time, after used_at is set and past the
-- short replay window in src/lib/oauth/core.ts) every row sharing family_id is
-- revoked, per RFC 6819 §5.2.2.3. encrypted_successor lets a network-retried
-- refresh — the CLI's POST timed out but the server had already committed the
-- rotation — replay the exact same successor pair instead of tripping reuse
-- detection against itself and logging the user out for being unlucky.
create table if not exists oauth_refresh_tokens (
	id uuid primary key default gen_random_uuid(),
	token_hash text unique not null,
	family_id uuid not null,
	authorization_id uuid not null references oauth_authorizations (id) on delete cascade,
	vendor_id uuid not null references vendors (id) on delete cascade,
	scope text not null,
	successor_hash text,
	encrypted_successor text,
	used_at timestamptz,
	expires_at timestamptz not null,
	revoked_at timestamptz,
	created_at timestamptz not null default now()
);

create index if not exists oauth_refresh_tokens_token_hash_idx on oauth_refresh_tokens (token_hash);
create index if not exists oauth_refresh_tokens_family_idx on oauth_refresh_tokens (family_id);
create index if not exists oauth_refresh_tokens_vendor_idx on oauth_refresh_tokens (vendor_id);
alter table oauth_refresh_tokens enable row level security;

create policy "vendor members can read their own oauth refresh tokens" on oauth_refresh_tokens
	for select
	using (vendor_id in (select vendor_id from vendor_members where user_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- PHASE 7: oauth_rate_limits + oauth_rate_touch() — fixed-window counter.
-- ----------------------------------------------------------------------------
-- An in-memory counter does not survive across serverless instances, which
-- makes it worthless on an auth endpoint that is exactly what someone would
-- want to hammer. This is a small Postgres-backed fixed-window limiter instead,
-- shared by /authorize, /token, /revoke and the consent POST.
create table if not exists oauth_rate_limits (
	bucket text not null,
	window_start timestamptz not null,
	count integer not null default 0,
	primary key (bucket, window_start)
);

alter table oauth_rate_limits enable row level security;

-- Atomically bumps the counter for the current window and reports whether the
-- caller is still under `p_limit`. security definer so the function stays
-- callable independent of table grants, with search_path pinned so a caller
-- cannot shadow `oauth_rate_limits` with their own table. Granted ONLY to
-- service_role: with execute rights, a client could reset its own budget by
-- picking a bucket name and calling this directly.
create or replace function oauth_rate_touch(p_bucket text, p_window_seconds integer, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
	v_window_start timestamptz;
	v_count integer;
begin
	v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

	insert into oauth_rate_limits (bucket, window_start, count)
	values (p_bucket, v_window_start, 1)
	on conflict (bucket, window_start) do update set count = oauth_rate_limits.count + 1
	returning count into v_count;

	delete from oauth_rate_limits where window_start < now() - (p_window_seconds::text || ' seconds')::interval;

	return v_count <= p_limit;
end;
$$;

-- Supabase's public-schema default privileges grant EXECUTE on new functions to
-- anon/authenticated at creation time, independently of PUBLIC — revoking from
-- `public` alone leaves those direct grants in place, so all three are named.
revoke all on function oauth_rate_touch(text, integer, integer) from public, anon, authenticated;
grant execute on function oauth_rate_touch(text, integer, integer) to service_role;
