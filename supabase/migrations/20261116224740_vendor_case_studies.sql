-- Case studies (2026-11-14, Mathew: "That publishes it to a Letter Proof URL, and then you can decide to make a pull
-- request to put it onto your website"). Letter writes a case study from the vendor's usage data (the people and
-- companies its script saw signed in to the vendor's product, and the patterns in them), the vendor chooses what it
-- names, and Letter publishes it here (publish_case_study). Served at /case-studies/<id>, labelled as the vendor's
-- usage data counted by Letter, never signed and never moving the tier. Unpublishing keeps the row with removed_at.
-- Private: service role only, like vendor_feature_usage.

create table if not exists public.vendor_case_studies (
  -- Letter's id for the case study: one row per case study, republished in place.
  id uuid primary key,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  headline text not null check (char_length(headline) between 1 and 200),
  paragraphs text[] not null check (cardinality(paragraphs) between 1 and 8),
  -- The facts it was written from, as shown: [{ text, numbers }].
  facts jsonb not null default '[]',
  window_since date not null,
  window_until date not null,
  window_days integer not null check (window_days between 1 and 366),
  anonymization text not null check (anonymization in ('counts_only', 'companies_named')),
  named_companies text[] not null default '{}',
  source text not null default 'letter_usage_data',
  published_at timestamptz not null default now(),
  removed_at timestamptz
);

create index if not exists idx_vendor_case_studies_vendor on public.vendor_case_studies(vendor_id, published_at desc);

alter table public.vendor_case_studies enable row level security;
revoke all on table public.vendor_case_studies from anon, authenticated;
