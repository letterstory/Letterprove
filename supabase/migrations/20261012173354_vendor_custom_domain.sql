-- A vendor's proof page on its own domain: proof.acme.com, success.acme.com.
--
-- The vendor points a CNAME at Vercel; Letterprove attaches the hostname to its
-- own deployment and routes it by Host to /proofs/{slug}. The page, the
-- signatures and the verify links are unchanged: every verify link still goes
-- to app.letterprove.com, which is what keeps a proof served from the vendor's
-- own domain checkable rather than self-published. See
-- src/lib/vendors/custom-domain.ts.
--
-- `custom_domain` must sit under the vendor's verified `domain` (enforced in
-- the tool), so DNS control of acme.com is what earns proof.acme.com.
-- `custom_domain_verified_at` is when Vercel last reported the hostname both
-- verified and correctly configured; the proof page names it canonical only
-- from then on.
alter table vendors add column if not exists custom_domain text;
alter table vendors add column if not exists custom_domain_verified_at timestamptz;

create unique index if not exists vendors_custom_domain_key on vendors (custom_domain) where custom_domain is not null;

comment on column vendors.custom_domain is
	'Hostname serving this vendor''s proof page (e.g. proof.acme.com), a subdomain of `domain`. NULL when none. See src/lib/vendors/custom-domain.ts.';
comment on column vendors.custom_domain_verified_at is
	'When Vercel last reported custom_domain verified and its DNS correctly configured. NULL until then.';
