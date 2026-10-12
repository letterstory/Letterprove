-- letter.dev is a Letter Company product, created as a vendor on 2026-10-12
-- under the Letter org without the disclosure #169 gave our other vendors.
-- New vendors on our own domains now get it at creation
-- (src/lib/vendors/provision.ts); this backfills the one created before that.
update vendors set issuer_affiliation = 'Letter Company'
where slug = 'letter-dev' and issuer_affiliation is null;
