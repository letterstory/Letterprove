-- Durable history for the vendor-level aggregate.
--
-- published_snapshots does the same job for per-customer attestations. The
-- aggregate had none: every request recomputed a fresh one-entry chain with
-- prev_hash = GENESIS, so the one claim Letterprove actually publishes today
-- was signed but not auditable — README § Signing draws exactly that line,
-- "what upgrades the system from signed to auditable".
--
-- That gap matters more than it looks. Naming a customer needs that customer's
-- consent, so a vendor who never obtains it publishes the aggregate and
-- nothing else, permanently. Leaving it unchained means the only claim most
-- vendors will ever make is the one nobody can audit.
--
-- Separate table rather than a sentinel customer_slug in published_snapshots.
-- The aggregate is a different SUBJECT — a claim about the vendor, not about
-- any customer of theirs — and its body has a different shape
-- (companies_observed, domains_excluded). Squeezing it in behind a magic slug
-- like '*' would mean every query against that table had to remember to
-- exclude it, and the first one that forgot would count the aggregate as a
-- customer.
--
-- One row per (vendor, hour), same cadence as the snapshot freeze. The full
-- signed document is stored rather than its numbers: the signature covers the
-- whole body, and a later change to how the body is built must never alter
-- what was already signed and served.
--
-- RLS enabled with no policies, matching every other table here: only the
-- service-role client can read or write it.

create table if not exists published_aggregates (
	id bigint generated always as identity primary key,
	vendor_slug text not null,
	hour_bucket bigint not null,
	published_at timestamptz not null,
	attestation jsonb not null,
	created_at timestamptz not null default now(),
	unique (vendor_slug, hour_bucket)
);

create index if not exists published_aggregates_vendor_time_idx
	on published_aggregates (vendor_slug, hour_bucket desc);

alter table published_aggregates enable row level security;
