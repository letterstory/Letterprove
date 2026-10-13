import { dbClient } from "@/lib/db/client";
import { recheckAllDomains, type RecheckRunResult } from "@/lib/vendors/dns-recheck";
import { sendAlert } from "@/lib/alerts/notify";

/**
 * Vercel Cron hits this daily (see vercel.json): re-resolves every verified
 * vendor's DNS TXT record so domain proof stays current. The rules — what
 * counts as a miss, and three misses over two days before verification is
 * cleared — live in src/lib/vendors/dns-recheck.ts.
 *
 * Same auth as the other crons: Vercel signs its invocations with
 * `Authorization: Bearer $CRON_SECRET`, and an unset secret fails closed.
 *
 * 04:30 UTC, clear of every other slot (:00 rollup, :05 freeze, every-15-minute health,
 * :50 stripe sync, 03:15 billing rollup). Losing verification takes effect at
 * the next freeze, so the time of day only decides which hour's snapshot is
 * the first to fall to tier 0.
 */
export async function GET(request: Request) {
	const auth = request.headers.get("authorization");
	if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
		return new Response("unauthorized", { status: 401 });
	}

	const db = dbClient();
	let run: RecheckRunResult;
	if (!db) {
		run = { ok: false, checked: 0, present: 0, missed: 0, unreachable: 0, unverified: [], errors: [], detail: "storage unavailable" };
	} else {
		try {
			run = await recheckAllDomains(db);
		} catch (error) {
			// recheckAllDomains is written not to throw; this keeps a surprise
			// from becoming silence.
			run = {
				ok: false,
				checked: 0,
				present: 0,
				missed: 0,
				unreachable: 0,
				unverified: [],
				errors: [],
				detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	if (run.detail) await sendAlert("dns recheck could not run", run.detail);

	// A vendor losing verification changes what it publishes within the hour,
	// so it is worth a person knowing — usually it is a DNS migration that
	// dropped the record, and the vendor will want to re-add it.
	for (const slug of run.unverified) {
		await sendAlert(
			`domain verification cleared: ${slug}`,
			"its verification TXT record was missing for three consecutive daily checks over two days; its tiers fall to 0 at the next freeze until it verifies again",
		);
	}
	for (const e of run.errors) {
		await sendAlert(`dns recheck error: ${e.slug}`, e.detail);
	}

	return Response.json(run, { status: run.ok ? 200 : 500 });
}
