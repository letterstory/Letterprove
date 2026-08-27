/**
 * Read every row a query matches, instead of however many PostgREST felt like
 * returning.
 *
 * Supabase caps an unbounded `select()` at `db-max-rows` — 1000 on this
 * project, confirmed by measurement: `published_snapshots` held 1421 rows and
 * an unbounded select returned exactly 1000. There is no error, no flag, and
 * no truncation marker. The query simply answers with a prefix.
 *
 * That is survivable for a list somebody scrolls. It is not survivable here,
 * because two of the callers feed CHAINS:
 *
 *   - `loadPersistedChain` reads a customer's whole signed history, and
 *     `buildChainFor` links each new attestation onto `persisted.at(-1)`. Take
 *     a prefix and `.at(-1)` stops being the newest entry — so the freeze
 *     writes a `prev_hash` pointing at a stale predecessor and the chain
 *     forks. Permanently: those rows are immutable by design.
 *   - `observedTotals` sums rollups into `companies_observed` and `sessions`,
 *     which are then signed. A prefix means a signed document understating its
 *     own evidence, which is precisely the shape of claim this product exists
 *     to make impossible.
 *
 * Both were within about a month of the cap when this was written (longest
 * chain 234 rows, growing 24/day from the hourly freeze).
 *
 * Errors propagate rather than resolving to a partial result. Every caller
 * already separates "read failed" from "nothing there" — a failed telemetry
 * read must never publish as a confident zero — and silently returning the
 * pages that happened to succeed would collapse that distinction in the one
 * direction it must never collapse.
 */

/** PostgREST's cap on this project. Pages at exactly the boundary so a full page means "probably more". */
const PAGE_SIZE = 1000;

/**
 * Refuses to loop forever if a query somehow never shrinks. 500 pages is half a
 * million rows — far past anything real here, and a bug worth crashing on
 * rather than paging through until the request times out.
 */
const MAX_PAGES = 500;

export interface PagedResult<T> {
	data: T[] | null;
	error: { message: string } | null;
}

/**
 * `page(from, to)` must return the same query with `.range(from, to)` applied.
 * Taking a builder rather than query parts keeps every filter, ordering and
 * column list at the call site, where it can be read next to the thing it
 * belongs to.
 *
 * IMPORTANT: the query must have a deterministic `.order(...)`. Paging an
 * unordered query can repeat or skip rows between pages, because Postgres is
 * free to return them in any order it likes.
 */
export async function readAllRows<T>(
	label: string,
	page: (from: number, to: number) => PromiseLike<PagedResult<T>>,
): Promise<T[]> {
	const all: T[] = [];

	for (let i = 0; i < MAX_PAGES; i++) {
		const from = i * PAGE_SIZE;
		const { data, error } = await page(from, from + PAGE_SIZE - 1);

		if (error) throw new Error(`${label}: ${error.message}`);

		const rows = data ?? [];
		all.push(...rows);

		// A short page is the last page. A full one might not be, so ask again —
		// the extra round trip on an exact multiple is cheaper than guessing.
		if (rows.length < PAGE_SIZE) return all;
	}

	throw new Error(`${label}: exceeded ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} rows) — refusing to keep paging`);
}
