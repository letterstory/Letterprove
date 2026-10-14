-- Site proof for the attestation: the middle of three domain states.
--
-- Since 2026-10-14 DNS is optional for publishing proofs. A vendor's domain is
-- one of: not verified (tier 0), site verified (Letterprove fetched a page the
-- vendor named on that domain and found attest.js carrying the vendor's current
-- key), or DNS verified (domain_verified_at, unchanged). src/lib/vendors/site-proof.ts.
--
-- site_verified_url is the page the key was found on; the daily re-check
-- (dns-recheck cron) re-fetches it and clears site_verified_at after three
-- answered misses over two days, like DNS. Additive only.

alter table vendors
	add column if not exists site_verified_at timestamptz,
	add column if not exists site_verified_url text,
	add column if not exists site_checked_at timestamptz,
	add column if not exists site_check_failures integer not null default 0,
	add column if not exists site_failing_since timestamptz;

comment on column vendors.site_verified_at is
	'When Letterprove last found attest.js with this vendor''s key on site_verified_url (a page on the vendor''s domain). Middle domain proof: weaker than DNS. Null when not site-verified.';
comment on column vendors.site_verified_url is
	'The https page on the vendor''s domain where the key was found. Re-checked daily.';
