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
 * expensive ones. Every failure path pages, and says how far it got, because
 * "the freeze failed" does not tell you whose proofs stopped updating.
 *
 * One half since 2026-10-13: the vendor attestations. Per-customer snapshots
 * were retired (README decision 30) and are no longer frozen; their stored
 * history is untouched.
 */
type Half = { ok: boolean; frozen: number; skipped?: string[]; detail?: string };

const SKIPPED_NAMES_IN_ALERT = 5;

/**
 * Everything a human needs out of a single Slack line: why it broke, how far
 * it got before it broke, and which vendors were left out. `frozen` is blast
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

	const aggregates = settled((await Promise.allSettled([freezeAggregates()]))[0]);
	if (!aggregates.ok) {
		await sendAlert("hourly freeze failed: vendor attestations", failureDetail(aggregates));
	}
	return Response.json({ ok: aggregates.ok, aggregates }, { status: aggregates.ok ? 200 : 500 });
}
