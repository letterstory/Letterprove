-- Two scripts: attest.js (attestation) and visit.js (Visitors: AI agents and
-- people, served as lettervisit.com/v.js). /api/v1/config learns which one
-- asked from `s=attest|visit` and stamps the first time each was seen, so the
-- app can say which tag is installed. config_pings keeps meaning "either
-- script" (script_seen_at). A request with no `s` is an attest.js from before
-- the split, so it stamps proofs_script_seen_at.
--
-- Timestamps only; set once, never overwritten. Additive only: migrations
-- apply during the production build, before the new code serves.

alter table vendors
	add column if not exists visitors_script_seen_at timestamptz,
	add column if not exists proofs_script_seen_at timestamptz;
