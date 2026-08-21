-- One row per vendor that GET /v1/config has ever been served for. Exists
-- so the dashboard can tell "attest.js booted, nobody's called identify()
-- yet" apart from "attest.js never loaded at all" — hot_events only gets a
-- row once a vendor's page calls identify()/signup()/login(), so a
-- marketing-only page with the script installed but no such call anywhere
-- looks identical to a broken install without this. See
-- src/lib/telemetry/ping.ts and src/lib/vendors/status.ts.
--
-- RLS enabled with no policies, same as hot_events: only the service role
-- (which bypasses RLS) ever touches this table.

create table if not exists config_pings (
	vendor_slug text primary key,
	first_seen timestamptz not null default now(),
	last_seen timestamptz not null default now()
);

alter table config_pings enable row level security;
