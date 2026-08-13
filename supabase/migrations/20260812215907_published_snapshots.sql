-- Durable attestation history. README § Publish: "chained to its
-- predecessor via prev_hash. This is what makes the system auditable."
-- Until this table existed, every customerChain() call recomputed a fresh
-- one-entry chain from hot_rollups on the spot — a valid signed snapshot,
-- but never more than one, so there was nothing to walk.
--
-- One row per (vendor, customer, hour): the hourly freeze cron
-- (src/rollup/freeze.ts) upserts the current hour's entry, chaining it onto
-- the previous hour's stored attestation via prev_hash. `attestation` holds
-- the full signed document as published — not just the numeric columns —
-- because the signature covers the whole body and a later fixture edit
-- (a renamed customer, a changed tier) must never alter what was already
-- signed and handed out.
--
-- RLS is enabled with no policies, matching hot_events/hot_rollups: only
-- the service-role client (dbClient()) can read or write this table.

create table if not exists published_snapshots (
	id bigint generated always as identity primary key,
	vendor_slug text not null,
	customer_slug text not null,
	hour_bucket bigint not null,
	published_at timestamptz not null,
	attestation jsonb not null,
	created_at timestamptz not null default now(),
	unique (vendor_slug, customer_slug, hour_bucket)
);

create index if not exists published_snapshots_customer_time_idx
	on published_snapshots (vendor_slug, customer_slug, hour_bucket desc);

alter table published_snapshots enable row level security;
