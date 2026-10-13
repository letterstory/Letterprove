-- One script, three modules (Matthew's "Scripts" IA), and what a vendor shows
-- on its public proof.
--
-- module_proofs / module_agent_visitors: whether attest.js sends sign-ins
-- (the proof's evidence) and agent-visit beacons. Human visitors (Maverick)
-- keeps its existing column, visitor_identification_enabled.
--
-- server_seen_at: the first request of any kind the vendor's server snippet
-- forwarded to /api/v1/agent-visit, so the app can say "server snippet
-- installed" before any agent has visited. A timestamp only; nothing about
-- the request is kept.
--
-- proof_display: optional proof sections the vendor chose to hide. Absent keys
-- mean shown. The domain, tier, companies observed and the verify link are
-- never hideable (src/lib/attest/display.ts), and the attestation lists what
-- was hidden in hidden_by_vendor so an agent knows it was a choice.
--
-- Additive only: migrations apply during the production build, before the new
-- code serves.

alter table vendors
	add column if not exists module_proofs boolean not null default true,
	add column if not exists module_agent_visitors boolean not null default true,
	add column if not exists server_seen_at timestamptz,
	add column if not exists proof_display jsonb not null default '{}'::jsonb;
