-- Unlisted proofs. A published vendor can be taken out of Letterprove's
-- listings (discovery, the sitemap, llms.txt) while its proof page and signed
-- attestation stay at their URLs, so links keep working. Unlisted pages ask
-- search engines not to index them. Listing is presentation, not evidence: it
-- never changes the signed document.
alter table public.vendors
  add column if not exists proofs_listed boolean not null default true,
  add column if not exists listed_changed_at timestamp with time zone,
  add column if not exists listed_changed_by text;

comment on column public.vendors.proofs_listed is
  'False = unlisted: proof and attestation still served by URL, but never enumerated (discovery, sitemap, llms.txt) and marked noindex.';
comment on column public.vendors.listed_changed_by is
  'Who last changed proofs_listed: the principal user id or token id.';
