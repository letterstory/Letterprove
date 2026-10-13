-- Two reads behind the proof's growth and retention sections. Both are counts
-- from Letterprove's own observations; neither names a customer.
--
-- vendor_monthly_companies: per calendar month (UTC), the highest
-- companies_observed any signed snapshot of the vendor carried that month,
-- from published_aggregates (the signed, frozen history). Grouped in SQL so
-- the read is one value, not one row per hourly snapshot. Returns a jsonb
-- array of { month: "YYYY-MM", companies_observed }, oldest first.
--
-- vendor_window_domains: the distinct company domains observed in hot_rollups
-- between two instants, as a text array. Retention compares two windows of
-- it; attribution (free mail, our own domains) is applied in TypeScript by
-- the same classifier the attestation uses.
--
-- Single-value returns on purpose: supabase-js rpc and the test harness both
-- read one value cleanly.

create or replace function vendor_monthly_companies(p_vendor_slug text, p_months integer)
returns jsonb
language sql
stable
set search_path = public
as $$
	select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'companies_observed', m.companies_observed) order by m.month), '[]'::jsonb)
	from (
		select
			to_char(date_trunc('month', published_at at time zone 'utc'), 'YYYY-MM') as month,
			max((attestation->>'companies_observed')::integer) as companies_observed
		from published_aggregates
		where vendor_slug = p_vendor_slug
			and published_at >= (date_trunc('month', now() at time zone 'utc') - make_interval(months => greatest(p_months, 1) - 1)) at time zone 'utc'
			and attestation ? 'companies_observed'
		group by 1
	) m;
$$;

create or replace function vendor_window_domains(p_vendor_slug text, p_from timestamptz, p_to timestamptz)
returns text[]
language sql
stable
set search_path = public
as $$
	select coalesce(array_agg(distinct domain), '{}')
	from hot_rollups
	where vendor_slug = p_vendor_slug
		and window_start >= p_from
		and window_start < p_to;
$$;

revoke execute on function vendor_monthly_companies(text, integer) from public, anon, authenticated;
revoke execute on function vendor_window_domains(text, timestamptz, timestamptz) from public, anon, authenticated;
