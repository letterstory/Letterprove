import { rollupAgenticReads, pruneAgenticReadEvents, type PruneResult } from "@/rollup/agentic-reads";
import { sendAlert } from "@/lib/alerts/notify";

/**
 * Vercel Cron hits this daily (see vercel.json) — turns raw
 * agentic_read_events into the per-vendor monthly count
 * src/lib/billing/agentic-reads.ts prices. Daily, not hourly like
 * /api/cron/rollup: this feeds a monthly bill, not a live proof page, and the
 * rollup rescans up to two full months of raw rows every run (see
 * rollup_agentic_reads_daily's own comment) — hourly would 24x that cost for
 * no freshness anyone reads. Same auth and rollup-then-prune shape as
 * /api/cron/rollup otherwise, kept as a separate route because this one feeds
 * an invoice rather than a proof: its failure mode (an under-counted or stale
 * bill) is a billing bug, not a signal-freshness one, and the two must be
 * able to fail independently without paging on the other's behalf.
 */
export async function GET(request: Request) {
	const auth = request.headers.get("authorization");
	if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response("unauthorized", { status: 401 });
	}

	let result: Awaited<ReturnType<typeof rollupAgenticReads>>;
	try {
		result = await rollupAgenticReads();
	} catch (error) {
		result = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (!result.ok) {
		await sendAlert("agentic-read billing rollup failed (all vendors)", result.detail ?? "no detail reported");
	}

	// Retention rides on the same daily tick as the rollup, for the same
	// reason /api/cron/rollup rides prune on its own tick: the rows it
	// deletes are weeks outside the rollup's 2-month window, so the two
	// cannot interact, and a prune failure must not turn a successful
	// rollup into a retried one.
	let prune: PruneResult;
	try {
		prune = await pruneAgenticReadEvents();
	} catch (error) {
		prune = { ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!prune.ok) {
		await sendAlert("agentic-read event prune failed (all vendors)", prune.detail ?? "no detail reported");
	}

	return Response.json({ ...result, prune }, { status: result.ok ? 200 : 500 });
}
