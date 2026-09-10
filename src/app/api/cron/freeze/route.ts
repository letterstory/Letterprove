import { freezeSnapshots } from "@/rollup/freeze";
import { freezeAggregates } from "@/rollup/freeze-aggregates";
import { sendAlert } from "@/lib/alerts/notify";

/**
 * Vercel Cron hits this hourly, 5 minutes after /api/cron/rollup (see
 * vercel.json) so the hour it freezes already has hot_rollups written for
 * it. Not open to arbitrary callers: Vercel signs its own cron invocations
 * with `Authorization: Bearer $CRON_SECRET`, so an unset secret fails
 * closed rather than leaving the endpoint open.
 *
 * This is the route that signs and publishes, so its failures are the
 * expensive ones. They used to also be the quiet ones: a failed half returned
 * 500 into Vercel's logs and nothing told a human, while the served
 * attestations went on advertising a `published_at` and a `ttl` that said they
 * were current. Every failure path here now pages, and names which half died
 * and how far it got, because "the freeze failed" does not tell you whose
 * proofs stopped updating.
 */
type Half = { ok: boolean; frozen: number; skipped?: string[]; detail?: string };

const SKIPPED_NAMES_IN_ALERT = 5;

/**
 * Everything a human needs out of a single Slack line: why it broke, how far
 * it got before it broke, and which subjects were left out. `frozen` is blast
 * radius in the other direction, since dying at vendor 40 of 41 is a very
 * different morning from dying at vendor 1.
 */
function failureDetail(half: Half): string {
	const parts = [half.detail ?? "no detail reported", `froze ${half.frozen} before failing`];
	if (half.skipped?.length) {
		const shown = half.skipped.slice(0, SKIPPED_NAMES_IN_ALERT).join(", ");
		const rest = half.skipped.length - SKIPPED_NAMES_IN_ALERT;
		parts.push(`skipped ${half.skipped.length}: ${shown}${rest > 0 ? `, and ${rest} more` : ""}`);
	}
	return parts.join("; ");
}

/**
 * A throw becomes a failed half rather than an escaped exception. Promise.all
 * would reject on the first throw and discard the other half's result
 * entirely, which contradicts the whole reason these two are reported
 * independently, and would leave the alert unable to say which half died.
 */
function settled(result: PromiseSettledResult<Half>): Half {
	if (result.status === "fulfilled") return result.value;
	const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
	return { ok: false, frozen: 0, detail: `threw: ${message}` };
}

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
	const [snapshotsResult, aggregatesResult] = await Promise.allSettled([freezeSnapshots(), freezeAggregates()]);
	const snapshots = settled(snapshotsResult);
	const aggregates = settled(aggregatesResult);
	const ok = snapshots.ok && aggregates.ok;

	// One alert per failing half, not one per run. Partial failure is the
	// common case, and collapsing the two into "cron failed" would throw away
	// the only part of the message that says where to look.
	if (!snapshots.ok) {
		await sendAlert("hourly freeze failed: per-customer snapshots", failureDetail(snapshots));
	}
	if (!aggregates.ok) {
		await sendAlert("hourly freeze failed: vendor aggregates", failureDetail(aggregates));
	}

	// Response shape and status are unchanged: Vercel's retry and its failed
	// cron display key off the 500, and alerting must not change whether this
	// run reports success.
	return Response.json({ ok, snapshots, aggregates }, { status: ok ? 200 : 500 });
}
