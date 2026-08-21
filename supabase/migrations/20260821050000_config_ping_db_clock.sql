-- Stamp config_pings from the database clock instead of the app server's.
--
-- 20260821040000_config_pings.sql gives `first_seen` and `last_seen` a
-- `default now()` — the Postgres clock — but the upsert in ping.ts passed
-- `last_seen: new Date().toISOString()`, the Node clock on whichever Vercel
-- instance served the request. Two clocks stamping one row means the pair can
-- disagree, and on the very first ping in production it did: `last_seen`
-- landed 53ms BEFORE `first_seen`, which reads as a row that was last seen
-- before it existed.
--
-- 53ms is harmless on its own. The reason to fix it rather than round it off
-- is that `last_seen` only makes sense as a comparison — against `first_seen`,
-- against a staleness cutoff, against another vendor's — and every one of
-- those comparisons silently inherits the skew between two unsynchronised
-- clocks. Nothing reads `last_seen` yet (status.ts tests the row's existence,
-- not its age), so this is cheap to correct now and awkward later, once
-- something depends on it.
--
-- Doing it in one SQL function rather than a trigger keeps the write legible
-- at the call site: the caller passes a slug, the database decides the time.
-- A trigger would work too, but it would put the interesting behaviour in a
-- place nobody reading ping.ts would think to look.
create or replace function record_config_ping(slug text) returns void
language sql
as $$
	insert into config_pings (vendor_slug) values (slug)
	on conflict (vendor_slug) do update set last_seen = now();
$$;

comment on function record_config_ping(text) is
	'Upsert a vendor''s config-fetch ping, stamped from the database clock. Called by GET /v1/config via src/lib/telemetry/ping.ts.';

-- Deliberately NOT `security definer`. config_pings has RLS enabled with no
-- policies (see its own migration), so the service role — which bypasses RLS —
-- is the only caller that can write through this function, exactly as it was
-- the only caller that could write to the table directly. `security definer`
-- would hand that write to anon through PostgREST's RPC surface, turning a
-- table nobody outside the service role can touch into a public endpoint.
-- Revoking execute makes that fail at the door rather than at the row.
--
-- The grant that follows is not redundant. `create function` grants EXECUTE to
-- PUBLIC implicitly, and revoking from PUBLIC takes that away from every role
-- that had no grant of its own — which would include service_role if it were
-- relying on the implicit one, silently killing the ping this migration exists
-- to fix. Naming service_role explicitly makes the one caller that must keep
-- working independent of whatever the surrounding default privileges happen
-- to be.
revoke execute on function record_config_ping(text) from public, anon, authenticated;
grant execute on function record_config_ping(text) to service_role;
