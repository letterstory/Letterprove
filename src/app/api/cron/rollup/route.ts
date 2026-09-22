import { rollupHotEvents } from "@/rollup/sessions";
import { pruneHotEvents, type PruneResult } from "@/rollup/prune";
import { sendAlert } from "@/lib/alerts/notify";

/**
 * Vercel Cron hits this hourly (see vercel.json) — README § Signal roadmap:
 * "the hourly rollup ... reads this table next." Not open to arbitrary
 * callers: Vercel signs its own cron invocations with
 * `Authorization: Bearer $CRON_SECRET`, so an unset secret fails closed
 * rather than leaving the endpoint open.
 *
 * A failure here pages, because a rollup that stops running announces itself
 * nowhere a human looks: the freeze at :05 keeps succeeding on the stale
 * hot_rollups it can still see, so the proofs stay signed, stay
 * countersigned, and stay wrong. Returning 500 into Vercel's logs was the
 * whole of the old response to that.
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    auth !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("unauthorized", { status: 401 });
  }

  // One half, unlike the freeze: the aggregation is a single set-based upsert
  // inside the `rollup_hot_events_hourly` SQL function, so there is no partial
  // success to report and no per-vendor scope to name. When it fails it fails
  // for every vendor at once, and the alert says so rather than leaving a
  // reader to guess how wide the damage is.
  let result: Awaited<ReturnType<typeof rollupHotEvents>>;
  try {
    result = await rollupHotEvents();
  } catch (error) {
    // rollupHotEvents() is written not to throw, but this route exists so a
    // failure reaches a person. An unexpected throw must not be the one path
    // back to silence.
    result = {
      ok: false,
      detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!result.ok) {
    await sendAlert(
      "hourly rollup failed (all vendors)",
      result.detail ?? "no detail reported",
    );
  }

  // Retention rides on the same hourly tick rather than a cron of its own.
  // It runs whether or not the rollup succeeded: the rows it deletes are
  // weeks outside the rollup's 2-hour window, so the two cannot interact.
  // A failure pages separately and does NOT turn this run into a 500 — the
  // rollup's status is what Vercel's retry keys off, and retrying a
  // successful rollup because a delete failed would be the wrong response.
  let prune: PruneResult;
  try {
    prune = await pruneHotEvents();
  } catch (error) {
    prune = {
      ok: false,
      detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!prune.ok) {
    await sendAlert(
      "raw-event prune failed (all vendors)",
      prune.detail ?? "no detail reported",
    );
  }

  // Status is unchanged: Vercel's retry and its failed cron display key off
  // the 500, and alerting must not change whether this run reports success.
  return Response.json({ ...result, prune }, { status: result.ok ? 200 : 500 });
}
