-- Domain proof is kept current, not checked once.
--
-- verify_domain sets domain_verified_at when the TXT record is found, and
-- until now nothing ever looked again: a vendor that removed the record, let
-- the domain lapse, or sold it stayed "DNS-verified" forever, and every tier
-- it published kept saying "on a domain the vendor proved". The daily
-- /api/cron/dns-recheck re-resolves the record for every verified vendor
-- (src/lib/vendors/dns-recheck.ts). Three consecutive daily misses, spanning
-- at least 48 hours, clear domain_verified_at, which drops every tier that
-- vendor publishes to 0 until it verifies again. A DNS outage on our side
-- (SERVFAIL, timeout) is not a miss.
--
-- Additive only: migrations apply during the production build, before the
-- code that reads these columns is live.

alter table vendors
	add column if not exists domain_dns_checked_at timestamptz,
	add column if not exists domain_dns_failures integer not null default 0,
	add column if not exists domain_dns_failing_since timestamptz;

comment on column vendors.domain_dns_checked_at is
	'Last time the daily re-check resolved this vendor''s verification TXT record (found or not). Null until the first run.';
comment on column vendors.domain_dns_failures is
	'Consecutive daily re-checks that found DNS answering without the record. Reset to 0 when the record is found or the vendor re-verifies.';
comment on column vendors.domain_dns_failing_since is
	'When the current run of misses started. Null while the record is present.';
