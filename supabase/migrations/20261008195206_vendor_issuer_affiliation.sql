-- Who owns a vendor, when it is the same company that operates Letterprove.
--
-- In the 2026-10-08 AEO stress test Claude worked out from the names alone
-- that Letterprove and Lettertrace are related ("the vendor's sister project
-- is vouching for the vendor") and discounted the proof. The answer is to say
-- it first: a vendor with this set carries a signed disclosure in every
-- attestation it gets (src/lib/attest/issuer.ts), and its proof page says the
-- same.
--
-- WHY A NAME, NOT A BOOLEAN. The disclosure has to name the shared owner, and
-- "affiliated with whom" is the part a reader actually needs. NULL is the
-- default and means independent — the same null-is-the-ordinary-case shape as
-- `proofs_published_at` and `domain_verified_at`.
alter table vendors add column if not exists issuer_affiliation text;

comment on column vendors.issuer_affiliation is
	'The owner this vendor shares with Letterprove''s operator (e.g. ''Letter Company''), or NULL for an independent vendor. Non-null signs a disclosure into every attestation for this vendor. Set by a migration or staff, never by the vendor. See src/lib/attest/issuer.ts.';

-- Letter Company's own vendors today: two products and Steve's personal test
-- vendor (unpublished, marked so the disclosure is already in place if it ever
-- goes public). Decided by Casey, 2026-10-08.
update vendors set issuer_affiliation = 'Letter Company'
where slug in ('lettertrace', 'letterstory', 'steve-johnson') and issuer_affiliation is null;
