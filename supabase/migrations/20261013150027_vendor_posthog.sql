-- A vendor's read-only PostHog connection, and what it reported.
--
-- PostHog is the vendor's own analytics, so nothing read from it is evidence
-- in the sense the tiers use: the vendor controls the project, and anyone with
-- its public project key can send events into it. What it is good for is
-- HISTORY. Letterprove only observes from the day the script is installed;
-- PostHog usually knows which companies have been signing in for years. That
-- history is published as `reported_history`, labelled vendor-reported in
-- `vendor_stated`, and never moves the tier.
--
-- Read only. Letterprove never sends events into a vendor's PostHog.
--
-- Same posture as vendor_stripe_credentials: a separate table so a secret is
-- never one `select *` away from a public surface, RLS on with no policies so
-- only the service role reaches it.

create table if not exists vendor_posthog_credentials (
	vendor_id uuid primary key references vendors(id) on delete cascade,
	-- AES-256-GCM, iv:authTag:ciphertext. A PostHog personal API key, decrypted
	-- only to make an outbound read.
	encrypted_key text not null,
	key_last4 text not null,
	-- https origin of the PostHog instance (us.posthog.com, eu.posthog.com, or
	-- a self-hosted one) and the project the key reads.
	api_host text not null,
	project_id text not null,
	connected_at timestamptz not null default now(),
	last_synced_at timestamptz,
	last_sync_error text,
	consecutive_sync_failures integer not null default 0,
	-- Events in the last 30 days whose $host is the vendor's verified domain or
	-- one of its accepted hosts, as of the last sync. Zero means this project
	-- does not track the vendor's product, and its history is not published.
	host_events_30d integer,
	-- Identified domains that are not companies (free mail, ours, malformed),
	-- counted rather than stored.
	domains_excluded integer,
	truncated boolean not null default false
);

alter table vendor_posthog_credentials enable row level security;

comment on table vendor_posthog_credentials is
	'Read-only PostHog personal API keys per vendor. Service-role only: RLS on, no policies.';

-- One row per company domain PostHog has identified people from. Private:
-- customer domains never leave this table except as counts.
create table if not exists vendor_posthog_domains (
	vendor_id uuid not null references vendors(id) on delete cascade,
	domain text not null,
	-- When PostHog first created a person with an address at this domain.
	first_seen timestamptz,
	people integer not null default 0,
	-- Identified people from this domain with any event in the last 30 days.
	active_people_30d integer not null default 0,
	sessions_30d integer not null default 0,
	last_seen timestamptz,
	synced_at timestamptz not null,
	primary key (vendor_id, domain)
);

alter table vendor_posthog_domains enable row level security;

comment on table vendor_posthog_domains is
	'Company domains a vendor''s PostHog project has identified people from. Vendor-reported history, private; published only as counts.';
