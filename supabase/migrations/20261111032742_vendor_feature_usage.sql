-- Feature usage (2026-11-11, Casey and Mathew: "⌘L usage data will essentially be the proof for proofs"). Letter's
-- Visitors script on the vendor's own product counts which features its signed-in people use (Letter's
-- visitors_get_feature_usage); Letter pushes each feature's company domains here daily (report_feature_usage), and the
-- vendor picks which features its proof shows (set_feature_proofs). Published only as counts, and only of the
-- companies Letterprove itself observed signing in (lib/attest/feature-usage.ts). Private: service role only, like
-- vendor_posthog_domains.

create table if not exists public.vendor_feature_usage (
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  -- Letter's element key, e.g. button:#export or link:/reports@nav.
  feature_key text not null check (char_length(feature_key) between 1 and 200),
  -- The name shown on the proof: the vendor's own words for it, else Letter's label.
  label text not null check (char_length(label) between 1 and 80),
  -- Signed-in people who used it in the window, as Letter counted them.
  people integer not null default 0 check (people >= 0),
  -- The company domains (work email domains) whose people used it in the window.
  domains text[] not null default '{}',
  -- The vendor chose to show it on the proof.
  published boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (vendor_id, feature_key)
);

alter table public.vendor_feature_usage enable row level security;
revoke all on table public.vendor_feature_usage from anon, authenticated;
