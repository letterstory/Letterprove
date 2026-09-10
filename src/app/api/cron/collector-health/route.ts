import { checkCollectorHealth } from "@/lib/telemetry/health";
import { checkPublicationFreshness, type PublicationFreshness } from "@/rollup/freshness";
import { sendAlert } from "@/lib/alerts/notify";

/**
 * Vercel Cron hits this every 15 minutes (see vercel.json). It is the watchdog
 * cron: the one whose job is noticing the failures that do not announce
 * themselves.
 *
 * It pages when the collector's write path is broken — the failure mode
 * described in src/lib/telemetry/record.ts: an insert error is swallowed
 * there on purpose ("telemetry must never break the collector"), which also
 * means it's invisible unless something goes looking for it. Two prior
 * outages (src/lib/vendors/install.ts's header comment: a wrong install host
 * 404ing for 65 hours, and a snippet pointing at a host that never existed)
 * went unnoticed for exactly this reason — nothing was looking.
 *
 * It also pages when the published record has gone stale. That check lives
 * here rather than in the freeze cron on purpose: the failure it has to catch
 * includes the freeze not running at all, and a check inside the freeze cannot
 * report on an invocation that never happened. This route runs on its own 15
 * minute schedule, so it keeps looking after the hourly pair has stopped. It
 * costs two indexed single-row reads, which is why it did not need a fourth
 * entry in vercel.json.
 *
 * Not open to arbitrary callers, same posture as the other crons: Vercel
 * signs its own cron invocations with `Authorization: Bearer $CRON_SECRET`,
 * so an unset secret fails closed rather than leaving the endpoint open.
 */
export async function GET(request: Request) {
	const auth = request.headers.get("authorization");
	if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response("unauthorized", { status: 401 });
	}

	let collector: { ok: boolean; detail: string };
	try {
		collector = await checkCollectorHealth();
	} catch (error) {
		// checkCollectorHealth() isn't expected to throw, but this route exists
		// precisely because an unexpected failure must never go unreported —
		// the one thing it must not do is let a throw here look like "cron
		// didn't run" instead of "collector is broken."
		collector = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (!collector.ok) {
		await sendAlert("collector health check failed", collector.detail);
	}

	let publication: PublicationFreshness;
	try {
		publication = await checkPublicationFreshness();
	} catch (error) {
		// Same rule as above: a watchdog that dies quietly is worse than no
		// watchdog, because it also reads as "everything is fine."
		publication = {
			ok: false,
			checks: [
				{
					scope: "all published proofs",
					ok: false,
					detail: `staleness check threw: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}

	// One alert per failing scope, each carrying that scope in its subject, so
	// a reader knows from the Slack line alone whether every proof is stale or
	// only the per-customer half.
	for (const check of publication.checks) {
		if (!check.ok) {
			await sendAlert(`published record freshness: ${check.scope}`, check.detail);
		}
	}

	// The status code here has always meant "the thing this watches is broken",
	// never "this route is broken" — a failing canary already returned 500 while
	// the route itself worked perfectly. A stale published record is the same
	// kind of verdict, so it gets the same 500, which puts it on Vercel's
	// failed-cron display as a second channel that costs nothing.
	const ok = collector.ok && publication.ok;
	return Response.json({ ok, collector, publication }, { status: ok ? 200 : 500 });
}
