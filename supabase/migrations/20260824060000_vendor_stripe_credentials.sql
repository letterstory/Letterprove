-- A vendor's read-only Stripe credential, and the state of their connection.
--
-- Separate table rather than columns on `vendors` for one reason: `vendors` is
-- read on nearly every request, including the public proof pages, and a secret
-- should not be one `select *` away from a surface that serves strangers. A
-- table nothing reads by accident is easier to keep that way.
--
-- RLS on with NO policies, the same posture as hot_events: only the service
-- role — which bypasses RLS — can read or write this. There is deliberately no
-- vendor-facing select policy even for the non-secret columns, because RLS is
-- row-level and a policy that exposes the row exposes the ciphertext with it.
-- The dashboard reads a safe subset through the server instead.
create table if not exists vendor_stripe_credentials (
	vendor_id uuid primary key references vendors(id) on delete cascade,

	-- AES-256-GCM, iv:authTag:ciphertext. Never returned to any client; the
	-- application decrypts it only to make an outbound Stripe call.
	encrypted_key text not null,

	-- The last four characters, so a vendor can tell which key is connected
	-- without us storing or showing anything usable. Stripe shows the same
	-- suffix in their dashboard, which is what makes it recognisable.
	key_last4 text not null,

	-- Whether the connected key is live or test. Stored because publishing a
	-- claim corroborated by TEST-mode payments would be a false claim, and the
	-- sync has to be able to refuse it.
	livemode boolean not null,

	connected_at timestamptz not null default now(),
	last_synced_at timestamptz,
	-- Stripe's own message, kept so a vendor can be told "your key expired"
	-- rather than "sync failed".
	last_sync_error text
);

alter table vendor_stripe_credentials enable row level security;

comment on table vendor_stripe_credentials is
	'Read-only Stripe credentials per vendor. Service-role only: RLS is enabled with no policies, so no session-bound client can reach the ciphertext.';
comment on column vendor_stripe_credentials.livemode is
	'False for sk_test/rk_test keys. Tier-3 claims must never be built from test-mode payments — see src/lib/stripe/credentials.ts.';
