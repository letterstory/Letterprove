-- AI agents and crawlers visiting a vendor's own site, counted per day.
--
-- Fed by POST /api/v1/agent-visit: from the vendor's server (it forwards each
-- request's user-agent, client address and path) and from attest.js on pages
-- an automated browser renders. See src/lib/agents/visits.ts.
--
-- PRIVATE TO THE VENDOR. This is analytics about who reads the vendor's site,
-- never evidence about the vendor: nothing here is read by the attestation,
-- the tiers, or any public route. `verified` means the request came from an
-- address the claimed operator publishes for its agents; in server mode that
-- address is the one the vendor's server reported.
--
-- No address and no raw user-agent are stored — the classification is kept,
-- the identifier dropped, like agentic_read_events.
--
-- Additive only: Letterprove applies migrations during the production build,
-- before the new code serves; the running code never reads this table.

create table if not exists vendor_agent_visits (
	vendor_id uuid not null references vendors (id) on delete cascade,
	day date not null,
	agent text not null,
	kind text not null check (kind in ('ai_agent', 'search_crawler', 'automated_browser')),
	verified boolean not null,
	path text not null,
	count integer not null default 0,
	first_at timestamptz not null,
	last_at timestamptz not null,
	primary key (vendor_id, day, agent, kind, verified, path)
);

create index if not exists vendor_agent_visits_vendor_day_idx on vendor_agent_visits (vendor_id, day);

-- Service role only, like every other Letterprove table since 08-28.
alter table vendor_agent_visits enable row level security;

comment on table vendor_agent_visits is
	'Daily AI-agent/crawler visits to a vendor''s own site. Private analytics, never attestation input. src/lib/agents/visits.ts.';

-- One visit, folded into its day's row. A function rather than a client-side
-- read-modify-write so concurrent visits from many instances never lose a count.
create or replace function record_agent_visit(
	p_vendor_id uuid,
	p_agent text,
	p_kind text,
	p_verified boolean,
	p_path text,
	p_at timestamptz default now()
) returns void
language sql
as $$
	insert into vendor_agent_visits (vendor_id, day, agent, kind, verified, path, count, first_at, last_at)
	values (p_vendor_id, (p_at at time zone 'utc')::date, p_agent, p_kind, p_verified, p_path, 1, p_at, p_at)
	on conflict (vendor_id, day, agent, kind, verified, path) do update
		set count = vendor_agent_visits.count + 1,
			first_at = least(vendor_agent_visits.first_at, excluded.first_at),
			last_at = greatest(vendor_agent_visits.last_at, excluded.last_at);
$$;

revoke all on function record_agent_visit(uuid, text, text, boolean, text, timestamptz) from public;
grant execute on function record_agent_visit(uuid, text, text, boolean, text, timestamptz) to service_role;
