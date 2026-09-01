-- Retire vantage's demo customer fixtures ahead of the auth-unification drop.
--
-- 20260814230000_vendor_accounts.sql seeds `vantage` org-less with three demo
-- customers (acme-corp, northwind, globex). That is harmless in isolation, but
-- 20260828130000_unify_auth_drop_local_identity.sql's guard refuses to run
-- against ANY org-less vendor that still carries data — so every freshly
-- migrated database (CI, local dev, a fresh `db push`) was permanently stuck
-- failing the guard on vantage before that migration could ever land.
--
-- These three rows are demo data, not anything real: no-op in production,
-- where vantage already carries zero customers.
delete from vendor_customers
where vendor_id = (select id from vendors where slug = 'vantage')
  and slug in ('acme-corp', 'northwind', 'globex');
