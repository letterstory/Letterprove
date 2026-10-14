-- Site proof for visitor identification (People). A vendor's own Letterprove
-- key, found in a Visitors or Letterprove script tag on its homepage, proves
-- control of the site the same way the DNS TXT record proves control of the
-- domain: only someone who can edit the site can put that key there. People
-- accepts either proof; the attestation (tiers) still needs DNS.
--
-- site_verified_at: when the key was found (cleared after three misses over
-- two days, like domain_verified_at). site_checked_at: last attempt, for the
-- ten-minute rate limit on the automatic check. The two failure columns mirror
-- domain_dns_failures / domain_dns_failing_since.
--
-- visitor_identification_unlocked: People shows the first ten identified
-- people (by first seen) in full and the rest as a locked count; staff set this
-- after a call to show everyone. Identities are still never stored.
--
-- Additive only: migrations apply during the production build.

alter table vendors
	add column if not exists site_verified_at timestamptz,
	add column if not exists site_checked_at timestamptz,
	add column if not exists site_check_failures integer not null default 0,
	add column if not exists site_failing_since timestamptz,
	add column if not exists visitor_identification_unlocked boolean not null default false;
