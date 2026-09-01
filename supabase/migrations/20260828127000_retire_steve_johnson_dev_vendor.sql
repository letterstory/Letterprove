-- Retire steve-johnson-dev (personal dev vendor; its one customer,
-- letterbrace, was a consent-flow test run by Steve) so the guard in
-- 20260828130000 does not block the next deploy retry.
delete from vendors where slug = 'steve-johnson-dev';
