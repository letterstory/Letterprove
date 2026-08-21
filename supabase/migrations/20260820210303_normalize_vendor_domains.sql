-- Normalise existing vendors.domain to the bare hostname the collector pins
-- against.
--
-- /v1/observe compares `hostnameOf(Origin)` to `vendors.domain` for equality.
-- Signup never validated the field, so a vendor who pasted a URL stored
-- something that can never match — and because the collector is sendBeacon-safe
-- it answers 204 either way, so the vendor sees no error and collects nothing,
-- permanently. At the time of writing exactly one row was in that state:
--
--   steve-johnson-dev -> 'https://steve-johnson.dev/'   (never matches)
--
-- The application now rejects these at signup and on `update_vendor`
-- (src/lib/vendors/domain.ts). This fixes the rows already stored.
--
-- Deliberately conservative: strips scheme, path, port, trailing dot and
-- casing, and nothing else. In particular it does NOT fold `www.` away —
-- `www.acme.com` and `acme.com` are different origins, and a browser sends
-- whichever actually served the page, so "helpfully" rewriting one to the
-- other would cause the very silent mismatch this migration exists to remove.

update vendors
set domain = lower(
	-- trailing dot: 'acme.com.' -> 'acme.com'
	regexp_replace(
		-- port: 'acme.com:3000' -> 'acme.com'
		split_part(
			-- path: 'acme.com/pricing' -> 'acme.com'
			split_part(
				-- scheme: 'https://acme.com' -> 'acme.com'
				regexp_replace(btrim(domain), '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''),
				'/', 1
			),
			':', 1
		),
		'\.$', ''
	)
)
where domain is distinct from lower(
	regexp_replace(
		split_part(
			split_part(regexp_replace(btrim(domain), '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''), '/', 1),
			':', 1
		),
		'\.$', ''
	)
);

-- No unique constraint on `domain` here, deliberately. Two vendors claiming
-- the same host is a real question, but it is a product decision (and the
-- evidence gate already stops an impersonator manufacturing observations they
-- cannot collect), not a side effect of a data-cleanup migration. Left for a
-- separate call — see the PR discussion.
