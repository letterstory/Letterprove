-- Bootstrap policies for vendor self-service signup.
--
-- 20260814230000_vendor_accounts.sql only granted vendor_members read access
-- to rows a user already belongs to — correct for the dashboard, but it left
-- no way for a brand-new user to create their very first vendor + membership
-- row, since RLS defaults to deny. Signup is exactly that bootstrap: any
-- signed-in user may create ONE vendor org and immediately add themselves as
-- its owner. There is deliberately no UPDATE policy on `vendors` yet — domain
-- is load-bearing for the collector's origin pin (see fixtures/vendors.ts's
-- header comment), so letting a vendor edit it post-signup is a v1 problem,
-- not a v0 one.

create policy "an authenticated user can create a vendor" on vendors
	for insert
	with check (auth.uid() is not null);

create policy "a user can add themselves as a vendor member" on vendor_members
	for insert
	with check (user_id = auth.uid());
