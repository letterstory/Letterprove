import { dbClient } from "@/lib/db/client";
import { recheckAllDomains, type RecheckRunResult } from "@/lib/vendors/dns-recheck";
import { recheckOwnDnsHosts } from "@/lib/vendors/hosts";
import { sendAlert } from "@/lib/alerts/notify";
import { recheckAllLogoWalls } from "@/lib/vendors/logo-wall";
import { recheckAllSites } from "@/lib/vendors/site-verify";

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

	// Extra hosts that needed their own record (src/lib/vendors/hosts.ts) are
	// held to the same rule. Hosts under the verified domain lapse with it.
	let hosts: Awaited<ReturnType<typeof recheckOwnDnsHosts>> = { checked: 0, unverified: [], errors: [] };
	if (db) {
		try {
			hosts = await recheckOwnDnsHosts(db);
		} catch (error) {
			hosts.errors.push({ host: "*", detail: `threw: ${error instanceof Error ? error.message : String(error)}` });
		}
	}

	// Logo walls (README decision 36) are re-fetched daily here too: a company
	// taken off the vendor's page must stop being named within a day.
	let logos: Awaited<ReturnType<typeof recheckAllLogoWalls>> = { checked: 0, errors: [] };
	if (db) {
		try {
			logos = await recheckAllLogoWalls();
		} catch (error) {
			logos.errors.push({ vendorId: "*", detail: `threw: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	for (const e of logos.errors) console.error(`[letterprove:logo-wall] ${e.vendorId}: ${e.detail}`);

	// Site proofs (src/lib/vendors/site-verify.ts) for vendors without DNS, on
	// the same three-misses-over-two-days rule.
	let sites: Awaited<ReturnType<typeof recheckAllSites>> = { checked: 0, cleared: [], errors: [] };
	if (db) {
		try {
			sites = await recheckAllSites();
		} catch (error) {
			sites.errors.push({ slug: "*", detail: `threw: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	for (const e of sites.errors) console.error(`[letterprove:site-verify] ${e.slug}: ${e.detail}`);
	for (const slug of sites.cleared) {
		await sendAlert(
			`site verification cleared: ${slug}`,
			"its key was missing from its homepage for three consecutive daily checks over two days; visitor identification stops until the Visitors script is back",
		);
	}

	if (run.detail) await sendAlert("dns recheck could not run", run.detail);
	for (const h of hosts.unverified) {
		await sendAlert(
			`host verification cleared: ${h}`,
			"its own verification TXT record was missing for three consecutive daily checks over two days; events from it are no longer accepted until it is re-added",
		);
	}
	for (const e of hosts.errors) await sendAlert(`dns recheck host error: ${e.host}`, e.detail);

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

	return Response.json({ ...run, hosts, sites }, { status: run.ok ? 200 : 500 });
}
