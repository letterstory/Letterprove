import { freezeSnapshots } from "@/rollup/freeze";
import { freezeAggregates } from "@/rollup/freeze-aggregates";

/**
 * Vercel Cron hits this hourly, 5 minutes after /api/cron/rollup (see
 * vercel.json) so the hour it freezes already has hot_rollups written for
 * it. Not open to arbitrary callers: Vercel signs its own cron invocations
 * with `Authorization: Bearer $CRON_SECRET`, so an unset secret fails
 * closed rather than leaving the endpoint open.
 */
export async function GET(request: Request) {
	const auth = request.headers.get("authorization");
	if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response("unauthorized", { status: 401 });
	}

	// Both halves of the published record: per-customer snapshots and the
	// vendor-level aggregate. Run together because they must share an hour
	// bucket — a chain whose two halves disagreed about which hour they were
	// in would be far harder to reason about than one cron doing both.
	//
	// Independent results rather than a single ok: the aggregate publishes for
	// vendors with no customers at all, so snapshots freezing nothing is a
	// normal state and must not mask an aggregate failure, or vice versa.
	const [snapshots, aggregates] = await Promise.all([freezeSnapshots(), freezeAggregates()]);
	const ok = snapshots.ok && aggregates.ok;

	return Response.json({ ok, snapshots, aggregates }, { status: ok ? 200 : 500 });
}
