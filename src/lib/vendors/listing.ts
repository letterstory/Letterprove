import type { dbClient } from "@/lib/db/client";

type Db = NonNullable<ReturnType<typeof dbClient>>;

/**
 * Listing a NEW proof waits for data. A vendor who publishes before any
 * signed snapshot has sign-ins would otherwise put an empty proof in the
 * directory. So the first publish leaves it unlisted, marked as waiting, and
 * the hourly freeze lists it the first time a snapshot has companies in it.
 *
 * Who decided is on the row (`listed_changed_by`): these two system markers,
 * or the vendor's own principal from set_proof_listing. The freeze only ever
 * acts on the waiting marker, so a vendor's explicit choice is never undone.
 */
export const LISTING_AWAITING_DATA = "system:awaiting_data";
export const LISTING_FIRST_DATA = "system:first_data";

export interface ListingRow {
	proofs_listed?: boolean | null;
	listed_changed_by?: string | null;
}

/** Pure: unlisted only because no snapshot with sign-ins has been signed yet. */
export function listingPendingData(row: ListingRow): boolean {
	return row.proofs_listed === false && row.listed_changed_by === LISTING_AWAITING_DATA;
}

/**
 * Pure: should a first publish wait for data? Only when nobody has ever set
 * the listing (no `listed_changed_by`) and the latest signed snapshot has no
 * companies. A vendor who collected privately and already has data lists at once.
 */
export function shouldAwaitData(row: ListingRow, latestCompaniesObserved: number | null): boolean {
	if (row.listed_changed_by) return false;
	return !(typeof latestCompaniesObserved === "number" && latestCompaniesObserved >= 1);
}

/**
 * Called by the hourly freeze after a snapshot is written. Lists the vendor if
 * it was waiting for data and this snapshot has at least one company. The
 * filter carries every condition, so a concurrent vendor choice wins.
 */
export async function autoListOnFirstData(db: Db, vendorSlug: string, companiesObserved: number): Promise<boolean> {
	if (!(companiesObserved >= 1)) return false;
	try {
		return await listIfWaiting(db, vendorSlug);
	} catch {
		// Best effort: the next hourly freeze tries again.
		return false;
	}
}

async function listIfWaiting(db: Db, vendorSlug: string): Promise<boolean> {
	const { data, error } = await db
		.from("vendors")
		.update({ proofs_listed: true, listed_changed_by: LISTING_FIRST_DATA, listed_changed_at: new Date().toISOString() })
		.eq("slug", vendorSlug)
		.eq("proofs_listed", false)
		.eq("listed_changed_by", LISTING_AWAITING_DATA)
		.not("proofs_published_at", "is", null)
		.select("slug")
		.maybeSingle();
	if (error) return false;
	return data != null;
}
