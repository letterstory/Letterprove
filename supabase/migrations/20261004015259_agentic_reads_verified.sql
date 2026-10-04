-- Bill only agent reads we can attribute to the agent's operator.
--
-- A read was billable when its user-agent CLAIMED to be an AI agent, and a
-- user-agent is a free-text header: a loop sending "GPTBot" against a
-- vendor's proof could run up that vendor's bill at $0.20 a read. The
-- operators that matter publish the address ranges their crawlers fetch from
-- (OpenAI, Anthropic, Perplexity, Google, Apple, Common Crawl), so a claim is
-- now checked against those ranges at record time (src/lib/access/verify-agent.ts)
-- and only a matching request is `verified`.
--
-- Unverified agent reads are still recorded — they are evidence of spoofing,
-- and of agents whose operators publish nothing — but never counted toward a
-- bill. Existing rows predate verification and default to false, so they
-- stop counting; every vendor's September and October totals were under the
-- free allowance, so no bill changes.
--
-- The address used to verify is never stored. Only the outcome is.
alter table agentic_read_events add column if not exists verified boolean not null default false;

comment on column agentic_read_events.verified is
	'True when the request came from an address the claimed agent''s operator publishes. Only verified reads are billed.';

-- Same function as migration 20260926120000, counting verified reads only.
-- `count(*) filter`, not `where verified`: a month whose reads are all
-- unverified must still upsert to 0, overwriting any earlier count, rather
-- than vanish from the group and leave a stale total behind.
create or replace function rollup_agentic_reads_daily()
returns void
language sql
as $$
	insert into agentic_read_rollups (vendor_slug, billing_month, read_count, computed_at)
	select
		vendor_slug,
		date_trunc('month', receipt_ts)::date as billing_month,
		count(*) filter (where verified) as read_count,
		now()
	from agentic_read_events
	where receipt_ts >= date_trunc('month', now() - interval '1 month')
	group by vendor_slug, date_trunc('month', receipt_ts)
	on conflict (vendor_slug, billing_month)
	do update set
		read_count = excluded.read_count,
		computed_at = excluded.computed_at;
$$;
