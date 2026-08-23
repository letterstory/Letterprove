-- Approximate origin of each observation, for breadth/spoofing detection.
--
-- Disclosed on /privacy before this landed, not alongside it (#92): the
-- previous revision of that page promised the policy would change "before we
-- start collecting, not afterwards", and this is the collection.
--
-- Country and first-level region ONLY. Vercel hands us city, latitude,
-- longitude and postal code on the very same request and we deliberately take
-- none of them: a region holds millions of people and identifies none of them,
-- while the extra precision buys nothing a spoofer could not defeat anyway.
-- Anyone widening this has to change the published policy first.
--
-- Nullable for two separate reasons, both permanent rather than transitional:
--   1. Every row written before this migration has no location at all, and
--      backfilling would mean inventing one.
--   2. Vercel omits these headers when it cannot place an address, and local
--      development has no edge network in front of it, so null is a normal
--      steady-state value and not an error.
--
-- Sits alongside `asn`, which stays null — see the fraud-check module doc in
-- the countersigner for why ASN was deliberately declined rather than
-- forgotten.
alter table hot_events
	add column if not exists country text,
	add column if not exists region text;

comment on column hot_events.country is
	'Two-letter ISO 3166-1 country from x-vercel-ip-country. Null when the edge could not place the request, or for rows predating 2026-08-22.';
comment on column hot_events.region is
	'First-level ISO 3166-2 region (a state or equivalent) from x-vercel-ip-country-region. Deliberately the finest location granularity stored — never city, coordinates, or postal code.';
