import { syncAllVendorPayments, type StripeSyncRunResult } from "@/lib/stripe/sync-all";
import { sendAlert } from "@/lib/alerts/notify";

/**
 * Vercel Cron hits this hourly at :50 (see vercel.json). Not open to arbitrary
 * callers: Vercel signs its own cron invocations with
 * `Authorization: Bearer $CRON_SECRET`, so an unset secret fails closed rather
 * than leaving the endpoint open.
 *
 * WHY :50, and why hourly. The three existing crons occupy :00 (rollup), :05
 * (freeze) and every :15 (collector health), so :50 is the one slot in the
 * hour that collides with none of them. It is also the useful one rather than
 * merely the free one: payment evidence is read by `earned()` at publish time
 * and signed by the freeze, so evidence written at :50 is what the very next
 * freeze publishes fifteen minutes later. Running at :20 would have been just
 * as uncontended and left the fresh evidence sitting unpublished for
 * forty-five minutes. Hourly because the freeze republishes hourly: syncing
 * more often would write evidence nothing reads before it is rewritten, and
 * syncing less often would mean the signed record is knowingly older than the
 * cadence it advertises.
 *
 * It does not need the rollup that ran at :00. The observed-domain join in
 * sync.ts reads a thirty day window, so it is indifferent to whether the most
 * recent hour has been aggregated yet.
 *
 * Every failure names the vendor it belongs to. "The Stripe sync failed" is
 * not actionable across a set of vendors whose keys expire independently, and
 * the per-vendor subject also gives the suppression in lib/alerts/state.ts a
 * per-vendor key, so one vendor's dead credential cannot mute another's.
 */
export async function GET(request: Request) {
	const auth = request.headers.get("authorization");
	if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response("unauthorized", { status: 401 });
	}

	let run: StripeSyncRunResult;
	try {
		run = await syncAllVendorPayments();
	} catch (error) {
		// syncAllVendorPayments catches per vendor and is written not to throw,
		// but this route exists so a failure reaches a person. An unexpected
		// throw must not be the one path back to silence.
		run = {
			ok: false,
			attempted: 0,
			synced: 0,
			testMode: 0,
			truncated: [],
			failures: [],
			detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// The run never started. Alerted on its own subject rather than folded into
	// the per-vendor alerts, because nothing was synced and naming a vendor
	// would point an investigation at the wrong place.
	if (run.detail) {
		await sendAlert("stripe sync could not start", run.detail);
	}

	// One alert per failing vendor, not one per run. Partial failure is the
	// expected case here: a credential expires per vendor, and collapsing them
	// would throw away the only part of the message that says where to look.
	for (const failure of run.failures) {
		await sendAlert(`stripe sync failed: ${failure.vendorSlug}`, failure.detail);
	}

	// Truncation is not a failed sync and does not change the status: the
	// evidence written is correct as far as it goes. It still pages, because
	// what it publishes is a PREFIX of the truth and nothing downstream can
	// tell a prefix from the whole thing. fetch.ts says the remedy out loud:
	// a vendor this large needs incremental sync, not a bigger loop.
	for (const vendorSlug of run.truncated) {
		await sendAlert(
			`stripe sync truncated: ${vendorSlug}`,
			"hit the subscription page ceiling in lib/stripe/fetch.ts, so this vendor's payment evidence is incomplete",
		);
	}

	// A test-mode key syncs successfully and stores nothing, by design. It is
	// not counted as a failure and never alerts: the vendor is wiring things
	// up, and paging about it every hour would be paging about the product
	// working.
	//
	// Same convention as the other crons: the 500 puts a failed run on Vercel's
	// failed-cron display, which is a second channel that costs nothing.
	return Response.json(run, { status: run.ok ? 200 : 500 });
}
