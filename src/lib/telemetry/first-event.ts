import { dbClient } from "@/lib/db/client";

/**
 * Stamp `vendors.first_event_at` the first time a vendor's event is accepted.
 *
 * Remembered per instance, so it costs one conditional update per vendor per
 * instance lifetime rather than one per event. The `is null` filter makes it
 * idempotent across instances. Fire and forget: the collector never waits on it.
 */
const stamped = new Set<string>();

export function markFirstEvent(vendorId: string | undefined): void {
	if (!vendorId || stamped.has(vendorId)) return;
	stamped.add(vendorId);
	const db = dbClient();
	if (!db) return;
	void Promise.resolve(
		db.from("vendors").update({ first_event_at: new Date().toISOString() }).eq("id", vendorId).is("first_event_at", null),
	).catch(() => stamped.delete(vendorId));
}

/** Test seam. */
export function _resetFirstEvent(): void {
	stamped.clear();
}
