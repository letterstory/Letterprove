import { syncAllVendorPosthog, type PosthogSyncRun } from "@/lib/posthog/sync";
import { sendAlert } from "@/lib/alerts/notify";

/**
 * Vercel Cron hits this daily at 04:45 UTC (see vercel.json), after the DNS
 * re-check at 04:30 so a vendor whose domain just lapsed is read against the
 * current state. Daily, not hourly: this is history, and PostHog's query API
 * is rate limited per vendor. Same auth and alerting as the Stripe sync.
 */
export async function GET(request: Request) {
	const auth = request.headers.get("authorization");
	if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response("unauthorized", { status: 401 });
	}

	let run: PosthogSyncRun;
	try {
		run = await syncAllVendorPosthog();
	} catch (error) {
		run = { ok: false, attempted: 0, synced: 0, failures: [], detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (run.detail) await sendAlert("posthog sync could not start", run.detail);
	for (const failure of run.failures) {
		await sendAlert(`posthog sync failed: ${failure.vendorSlug}`, failure.detail);
	}
	return Response.json(run, { status: run.ok ? 200 : 500 });
}
