/**
 * Per-instance memo for the published chains (proofs.ts, aggregate.ts).
 *
 * A chain whose current hour is already frozen cannot change until the next
 * hour, so it is held for the rest of that hour. A chain that is still waiting
 * on this hour's freeze is held for a minute only: it ends at the previous
 * frozen hour, and the instance should pick up the new row soon after the
 * freeze writes it rather than serve an hour-old head until the hour turns.
 *
 * Keys carry the hour bucket, so an entry never outlives its hour. A rejected
 * load is evicted so the next request retries, rather than one transient
 * history-read error turning into an hour of 500s.
 */

const PENDING_TTL_MS = 60_000;

interface Entry<T> {
	value: Promise<T>;
	loadedAt: number;
	complete: boolean;
}

export function createHourlyMemo<T>(isComplete: (value: T) => boolean) {
	const entries = new Map<string, Entry<T>>();
	return (key: string, load: () => Promise<T>): Promise<T> => {
		const hit = entries.get(key);
		if (hit && (hit.complete || Date.now() - hit.loadedAt < PENDING_TTL_MS)) return hit.value;

		const entry: Entry<T> = { value: load(), loadedAt: Date.now(), complete: false };
		entry.value.then(
			(value) => {
				entry.complete = isComplete(value);
			},
			() => {
				if (entries.get(key) === entry) entries.delete(key);
			},
		);
		entries.set(key, entry);
		return entry.value;
	};
}
