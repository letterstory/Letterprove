-- Visitor identification: a vendor can have the people who visit its own site
-- identified by Maverick Intelligence, through the same attest.js tag.
--
-- This is a vendor-PRIVATE analytics feature and nothing more. Letterprove
-- stores no identified person: visitors are pulled live from Maverick when the
-- vendor asks (get_visitors), never written here, never signed, never public.
-- A company visiting a site is not evidence that it is a customer, so none of
-- this reaches the attestation.
--
-- Off by default. `maverick_customer_id` / `maverick_profile_id` are the
-- account-level pixel ids for our Maverick partner account, recorded once the
-- vendor's domain is registered as a Tracked Domain; /v1/config serves them to
-- attest.js only while enabled. `maverick_domains` lists the domains THIS
-- feature registered, so turning it off deactivates only those and never a
-- domain the partner account already tracked for another reason (our own
-- marketing sites share the account).
--
-- Additive only: migrations apply during the production build, before the new
-- code serves.

alter table vendors
	add column if not exists visitor_identification_enabled boolean not null default false,
	add column if not exists maverick_customer_id text,
	add column if not exists maverick_profile_id text,
	add column if not exists maverick_domains text[] not null default '{}';

comment on column vendors.visitor_identification_enabled is
	'Vendor opted in to Maverick visitor identification on its own site. Private analytics; never in an attestation.';
comment on column vendors.maverick_customer_id is
	'Maverick pixel data-customer-id, set once the vendor''s domain is a Tracked Domain. Null = pending registration.';
comment on column vendors.maverick_domains is
	'Domains this feature registered with Maverick (and so may deactivate). Pre-existing tracked domains are never listed.';
