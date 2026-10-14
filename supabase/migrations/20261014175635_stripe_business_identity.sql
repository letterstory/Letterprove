-- Stripe is now used only to confirm the vendor is a real, verified business at
-- its domain, never for payments (Casey, 2026-10-14). The account read already
-- runs on every connect and sync; these columns keep what it says about the
-- business so the attestation can state it.
--
-- The payment tables (vendor_payment_evidence, vendor_payment_unmatched,
-- vendor_stripe_payers) and the credential's product_ids are no longer written
-- or read. They stay for now (migrations here are additive-only during a
-- deploy) and are dropped in a later migration.
alter table public.vendor_stripe_credentials
  add column if not exists stripe_charges_enabled boolean,
  add column if not exists stripe_business_name text,
  add column if not exists stripe_country text,
  add column if not exists stripe_business_url_host text;
