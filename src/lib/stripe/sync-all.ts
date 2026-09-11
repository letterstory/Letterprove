/**
 * Sync every vendor who has connected a Stripe key, on a schedule.
 *
 * Payment evidence was exactly as fresh as the last time a human asked for it.
 * `sync_stripe_payments` exists on the dispatcher (#132) and nothing called it,
 * so a vendor whose customer cancelled in March kept publishing that payment in
 * September: `earned()` reads `vendor_payment_evidence` on every publish, the
 * hourly freeze signs the result, and a signed claim nobody can contradict is
 * the worst shape of wrong this product can produce. Stale is not a smaller
 * version of missing here. It is confidently wrong, which is the one thing an
 * evaluating agent cannot detect for itself.
 *
 * Driven from `vendor_stripe_credentials` rather than from `vendors`: the
 * table of vendors WITH a credential is the exact set of work, and reading the
 * vendor list first would mean one wasted round trip per vendor who has never
 * connected Stripe.
 *
 * INDEPENDENT RESULTS, the same pattern as the freeze cron. One vendor's
 * expired key must not stop the next vendor from syncing, and the report has
 * to name whose sync failed rather than saying "the cron failed" and leaving
 * a reader to guess how wide the damage is.
 */

import { dbClient } from "@/lib/db/client";
import { readAllRows } from "@/lib/db/read-all";
import { syncVendorPayments } from "./sync";

export interface VendorSyncFailure {
	vendorSlug: string;
	detail: string;
}

export interface StripeSyncRunResult {
	ok: boolean;
	/** Vendors with a credential, which is the set this run tried to sync. */
	attempted: number;
	/** Live-mode vendors whose evidence was replaced. */
	synced: number;
	/**
	 * Vendors whose key is test mode. NOT a failure and NOT alerted: sync.ts
	 * refuses to store test payments as evidence by design, and it clears any
	 * evidence still standing. The count is reported so a zero-evidence
	 * production is explainable without opening the database.
	 */
	testMode: number;
	/**
	 * Vendors whose subscription list hit fetch.ts's page ceiling. Their
	 * evidence is a prefix of the truth, which nothing downstream can tell from
	 * the complete thing.
	 */
	truncated: string[];
	failures: VendorSyncFailure[];
	/** Present when the run could not even work out who to sync. */
	detail?: string;
}

function empty(detail?: string): StripeSyncRunResult {
	return { ok: false, attempted: 0, synced: 0, testMode: 0, truncated: [], failures: [], detail };
}

export async function syncAllVendorPayments(): Promise<StripeSyncRunResult> {
	const db = dbClient();
	if (!db) return empty("no datastore configured");

	let connected: ConnectedVendors;
	try {
		connected = await connectedVendors();
	} catch (e) {
		// Distinct from a per-vendor failure, and reported separately: nothing
		// was synced and nothing CAN be until this read works, so an alert that
		// named a vendor here would be naming the wrong thing.
		return empty(`could not list vendors with a Stripe credential: ${e instanceof Error ? e.message : String(e)}`);
	}

	const { targets, orphans } = connected;
	const result: StripeSyncRunResult = {
		ok: true,
		attempted: targets.length + orphans.length,
		synced: 0,
		testMode: 0,
		truncated: [],
		// A credential whose vendor row is gone should be impossible: the foreign
		// key cascades on delete. Reported as a failure rather than skipped, so
		// the day that stops being true is the day somebody hears about it, and
		// reported per row rather than thrown, so one orphan cannot stop every
		// other vendor from syncing.
		failures: orphans.map((vendorId) => ({
			vendorSlug: vendorId,
			detail: "Stripe credential for a vendor row that no longer exists.",
		})),
	};

	for (const target of targets) {
		try {
			const sync = await syncVendorPayments(target.vendorId, target.vendorSlug);
			if (!sync.ok) {
				result.failures.push({ vendorSlug: target.vendorSlug, detail: sync.error });
				continue;
			}
			if (sync.truncated) result.truncated.push(target.vendorSlug);
			if (sync.testMode) result.testMode++;
			else result.synced++;
		} catch (e) {
			// syncVendorPayments is written not to throw, but a throw escaping
			// here would abandon every vendor after this one and report nothing
			// about why. Sequential and caught, rather than Promise.all: these are
			// outbound Stripe calls, and there is no reason to open a connection
			// per vendor at once against somebody else's rate limit.
			result.failures.push({
				vendorSlug: target.vendorSlug,
				detail: `threw: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	result.ok = result.failures.length === 0;
	return result;
}

/**
 * Every vendor holding a Stripe credential, with the slug the sync needs to
 * read their observed domains.
 *
 * Paged on both reads. A truncated list here is not a loud failure: it is a
 * set of vendors that silently stop being synced, which returns them to
 * exactly the stale-evidence problem this cron was written to end.
 *
 * Errors propagate rather than resolving to a partial list, for the same
 * reason readAllRows does it: syncing the vendors that happened to come back
 * and calling the run healthy is the one outcome that must not be possible.
 */
interface ConnectedVendors {
	targets: { vendorId: string; vendorSlug: string }[];
	/** Vendor ids holding a credential with no vendor row behind it. */
	orphans: string[];
}

async function connectedVendors(): Promise<ConnectedVendors> {
	const db = dbClient();
	if (!db) return { targets: [], orphans: [] };

	const credentials = await readAllRows<{ vendor_id: string }>("vendors with a Stripe credential", (from, to) =>
		db
			.from("vendor_stripe_credentials")
			.select("vendor_id")
			.order("vendor_id", { ascending: true })
			.range(from, to),
	);
	if (credentials.length === 0) return { targets: [], orphans: [] };

	const vendors = await readAllRows<{ id: string; slug: string }>("vendor slugs", (from, to) =>
		db.from("vendors").select("id, slug").order("id", { ascending: true }).range(from, to),
	);
	const slugById = new Map(vendors.map((v) => [v.id, v.slug]));

	const targets: { vendorId: string; vendorSlug: string }[] = [];
	const orphans: string[] = [];
	for (const credential of credentials) {
		const slug = slugById.get(credential.vendor_id);
		if (slug) targets.push({ vendorId: credential.vendor_id, vendorSlug: slug });
		else orphans.push(credential.vendor_id);
	}
	return { targets, orphans };
}
