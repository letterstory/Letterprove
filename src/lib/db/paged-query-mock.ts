/**
 * A `.from().select().eq().gte().order().range()` chain for tests, backed by an
 * array that it actually pages through.
 *
 * Every reader that could be silently truncated now pages via `readAllRows`,
 * and the hand-rolled mocks those tests used resolved at `.gte()` — one call,
 * one array, no `.range()`. Rewriting each of them to resolve at `.range()`
 * would have made them pass while testing nothing new: a mock that returns
 * everything on the first page can never exercise the second.
 *
 * So this pages for real. Give it 2500 rows and a caller doing the right thing
 * gets all 2500 across three requests; a caller that stopped paging gets 1000
 * and the test fails. That is the actual regression worth guarding — the bug
 * this replaced produced no error, just a prefix.
 *
 * Lives in src/ rather than a test folder because vitest's include covers
 * src/**, and the modules under test import from "@/lib/db/..." — keeping it
 * beside read-all.ts means the mock and the thing it mimics move together.
 */

/** Must match readAllRows' page size, or paging tests prove nothing about the real cap. */
const PAGE_SIZE = 1000;

export interface PagedMock {
	from: (table: string) => unknown;
	/** How many pages were actually requested — assert on this to prove paging happened. */
	pageCount: () => number;
}

/**
 * `rows` is the full result set. Filters (`eq`, `gte`, `order`) are accepted and
 * ignored: the readers under test build their own predicates and this exists to
 * exercise PAGING, not to reimplement PostgREST. Pass rows already filtered and
 * ordered the way the query would return them.
 */
export function pagedQueryMock<T>(rows: T[], options: { error?: { message: string } } = {}): PagedMock {
	let pages = 0;

	const builder = {
		select: () => builder,
		eq: () => builder,
		gte: () => builder,
		lt: () => builder,
		order: () => builder,
		range: async (from: number, to: number) => {
			pages++;
			if (options.error) return { data: null, error: options.error };
			return { data: rows.slice(from, to + 1), error: null };
		},
		// Some callers still finish with maybeSingle/limit on the same shape.
		limit: () => builder,
		maybeSingle: async () => ({ data: rows[0] ?? null, error: options.error ?? null }),
	};

	return {
		from: () => builder,
		pageCount: () => pages,
	};
}

export { PAGE_SIZE as MOCK_PAGE_SIZE };
