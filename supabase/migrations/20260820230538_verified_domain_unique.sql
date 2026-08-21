-- One verified vendor per domain. Partial, not total, and the "partial" is the
-- entire point of the change.
--
-- `slug` and `key` are unique; `domain` never has been, and the previous
-- migration (20260820210303_normalize_vendor_domains.sql) said so explicitly
-- and left the question for a separate call. This is that call.
--
-- A blanket `unique (domain)` would be a denial-of-service handed to whoever
-- signs up first. Claiming a domain requires nothing — you type it into a form
-- — so a squatter could register "stripe.com" on a free account and Stripe
-- would then be unable to create a vendor at all, with no self-service way out.
-- The claim is not the assertion worth protecting.
--
-- Verification is. Since 20260820211646 a vendor only gets `domain_verified_at`
-- by publishing a _letterprove TXT record on the domain, so two rows both
-- verified on one domain would mean two parties simultaneously controlling its
-- DNS. That is not a race to be resolved politely at the application layer; it
-- is a state that should be impossible, and the database is the only place that
-- can actually guarantee it — the check would otherwise be a read followed by a
-- write, which is a race by construction.
--
-- So: unlimited claimants, at most one prover. The squatter above still gets to
-- sit on the row, but they can never verify it out from under the real owner,
-- and the evidence gate already caps everything an unverified vendor can earn
-- at tier 0.
--
-- No case-insensitivity here on purpose: every write path runs the domain
-- through normalizeDomain() (src/lib/vendors/domain.ts), which lowercases, so
-- the stored values are already in one canonical form and a plain index over
-- the column is the right shape. If that contract ever stops holding, the fix
-- is to restore it at the write, not to paper over it with lower(domain) here.
--
-- Verified at the time of writing: three vendor rows, one verified, no domain
-- shared by two rows at any verification status. The index will build clean.

create unique index if not exists vendors_verified_domain_unique
	on vendors (domain)
	where domain_verified_at is not null;

comment on index vendors_verified_domain_unique is
	'At most one vendor may hold a verified claim on a domain. Partial so that unverified claims stay unconstrained — verifying requires DNS control, claiming requires only a form, and blocking duplicate claims would let a squatter lock out the real owner.';
