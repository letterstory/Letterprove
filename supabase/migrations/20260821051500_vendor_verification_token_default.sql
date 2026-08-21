-- domain_verification_token has never had a default or a trigger — only
-- 20260820211646_vendor_domain_verification.sql's one-time backfill UPDATE
-- ever set it. Every insert site since (onboarding/route.ts included) has
-- relied on the column defaulting itself, the same way vendors.id already
-- does, but nothing was ever added to make that true. A brand-new self-serve
-- vendor gets domain_verification_token: null and a permanent 409
-- no_verification_token from every surface that tries to verify.
--
-- Same token shape as the original backfill: a bare gen_random_uuid() hex,
-- unguessable but not secret (see the column comment).
alter table vendors
	alter column domain_verification_token
	set default replace(gen_random_uuid()::text, '-', '');

-- Catch any row that slipped through before this default existed.
update vendors
set domain_verification_token = replace(gen_random_uuid()::text, '-', '')
where domain_verification_token is null;
