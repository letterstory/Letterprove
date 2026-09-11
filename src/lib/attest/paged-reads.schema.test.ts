import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

import { currentSnapshot } from "@/rollup/snapshots";
import { domainArrivals } from "./domain-arrivals";
import { fraudFeatures } from "./fraud-features";
import { geoDistribution } from "./geo-distribution";

/**
 * The four readers that feed a signed number or the fraud gate, run against
 * real Postgres holding MORE ROWS THAN POSTGREST WILL RETURN.
 *
 * Their own unit suites hand back one page from a hand-rolled mock. That is a
 * fine way to test the arithmetic and a useless way to test paging: a mock that
 * returns everything on the first request can never exercise the second, and a
 * case that passes with ten rows says nothing about 1001. The bug being guarded
 * here produces no error and no marker, only a prefix, so the only test that
 * can see it is one where the prefix and the truth differ.
 *
 * So the shim below reproduces `db-max-rows`: a select with no `.range()` is
 * capped at 1000 rows and reports success, exactly as the real project does.
 * Each case asserts both halves, because only the pair is evidence — that the
 * unpaged form really is short (so the cap is being enforced and the fixture
 * really is over it) and that the paged form really is complete.
 *
 * Same approach as state.schema.test.ts and publish.schema.test.ts, and the
 * same reason: the failure lives in what Postgres and PostgREST do to the rows,
 * which a mocked client cannot show you.
 */

/** PostgREST's `db-max-rows` on this project. Must match read-all.ts's PAGE_SIZE. */
const MAX_ROWS = 1000;

/** Comfortably over the cap, and deliberately not a multiple of it: an exact multiple would hide an off-by-one on the last page. */
const OVER_CAP = 1207;

const VENDOR = "vantage";
const DOMAIN = "acme-corp.example";
/** Inside every reader's 30-day window. */
const BASE = Date.now() - 20 * 24 * 60 * 60 * 1000;

let pg: PGlite;
/** Bumped by the shim, so a case can prove a read really did take more than one request. */
let requests = 0;

/**
 * PostgREST answers in JSON, so a timestamptz reaches these readers as a STRING
 * and they compare and sort it as one. The pg driver hands back a Date. Left
 * unconverted the shim would be kinder than production — `.sort()` over Dates
 * and over ISO strings do not agree — so convert here rather than let a test
 * pass on a shape the real client never produces.
 */
function isoTimestamps(row: unknown): unknown {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
		out[key] = value instanceof Date ? value.toISOString() : value;
	}
	return out;
}

/**
 * A Supabase-shaped builder over real Postgres, covering the chain these four
 * readers build: select / eq / gte / order / range.
 *
 * The default `limit MAX_ROWS` is the whole point. A chain that never reaches
 * `.range()` still resolves, still reports `error: null`, and still returns
 * fewer rows than it matched — which is what a caller that forgets to page
 * actually experiences in production.
 */
function pgliteSupabase() {
	return {
		from(table: string) {
			const where: string[] = [];
			const args: unknown[] = [];
			const orders: string[] = [];
			let columns = "*";
			let limitOffset = ` limit ${MAX_ROWS}`;

			const run = async () => {
				requests++;
				const sql =
					`select ${columns} from ${table}` +
					(where.length ? ` where ${where.join(" and ")}` : "") +
					(orders.length ? ` order by ${orders.join(", ")}` : "") +
					limitOffset;
				try {
					const { rows } = await pg.query(sql, args);
					return { data: rows.map(isoTimestamps), error: null };
				} catch (e) {
					return { data: null, error: { message: (e as Error).message } };
				}
			};

			const builder = {
				select(c: string) {
					columns = c;
					return builder;
				},
				eq(column: string, value: unknown) {
					args.push(value);
					where.push(`${column} = $${args.length}`);
					return builder;
				},
				gte(column: string, value: unknown) {
					args.push(value);
					where.push(`${column} >= $${args.length}`);
					return builder;
				},
				order(column: string, options?: { ascending?: boolean }) {
					orders.push(`${column} ${options?.ascending === false ? "desc" : "asc"}`);
					return builder;
				},
				range(from: number, to: number) {
					limitOffset = ` limit ${to - from + 1} offset ${from}`;
					return run();
				},
				/** An unpaged chain has to resolve TRUNCATED rather than fail. That is the shape of the bug: success, no marker, fewer rows. */
				then<R>(onFulfilled: (value: Awaited<ReturnType<typeof run>>) => R) {
					return run().then(onFulfilled);
				},
			};
			return builder;
		},
	};
}

beforeAll(async () => {
	pg = new PGlite();
	await pg.exec(`
		do $$ begin
			if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
			if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
			if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
		end $$;
		create schema if not exists auth;
		create table if not exists auth.users (id uuid primary key);
		create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
	`);
	const dir = join(process.cwd(), "supabase/migrations");
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
		await pg.exec(readFileSync(join(dir, file), "utf8"));
	}
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase() as never);
	await pg.query("delete from hot_rollups");
	await pg.query("delete from hot_events");
	requests = 0;
});

/** What a reader would have seen WITHOUT paging — the "is this fixture really over the cap" half of each case. */
async function unpagedCount(table: string) {
	const { rows } = await pg.query<{ n: number }>(
		`select count(*)::int as n from (select 1 from ${table} limit ${MAX_ROWS}) capped`,
	);
	return rows[0].n;
}

/**
 * `domainsPerHour` rows share each `window_start`, which is how hot_rollups
 * really behaves: one row per (domain, hour). Ties across a page boundary are
 * the thing the ordering has to survive, so they have to exist in the fixture.
 */
async function seedRollups(count: number, options: { domainsPerHour?: number; sessions?: number } = {}) {
	const perHour = options.domainsPerHour ?? 1;
	const values: string[] = [];
	const args: unknown[] = [];
	for (let i = 0; i < count; i++) {
		const hour = Math.floor(i / perHour);
		const domain = perHour === 1 ? DOMAIN : `d${i % perHour}.example`;
		args.push(VENDOR, domain, new Date(BASE + hour * 3_600_000).toISOString(), options.sessions ?? 1);
		const n = args.length;
		values.push(`($${n - 3}, $${n - 2}, $${n - 1}, $${n})`);
	}
	await pg.query(`insert into hot_rollups (vendor_slug, domain, window_start, sessions) values ${values.join(", ")}`, args);
}

describe("domainArrivals, over the row cap", () => {
	// The worst of the four. The query is unwindowed by design and ascending, so
	// a truncated read keeps the OLDEST 1000 rows: first_seen freezes at the
	// domains that existed when the vendor crossed the cap, and no domain
	// invented afterwards ever reaches the countersigner's clump detector. The
	// one check built to catch fabricated breadth goes blind, silently, for good.
	it("sees every domain, including ones that only appear past the cap", async () => {
		await seedRollups(OVER_CAP, { domainsPerHour: OVER_CAP });

		expect(await unpagedCount("hot_rollups")).toBe(MAX_ROWS);

		const arrivals = await domainArrivals(VENDOR);
		expect(arrivals.first_seen).toHaveLength(OVER_CAP);
		expect(requests).toBeGreaterThan(1);
	});

	it("still reports the vendor's own earliest observation, not the oldest row of a prefix", async () => {
		await seedRollups(OVER_CAP, { domainsPerHour: OVER_CAP });

		expect((await domainArrivals(VENDOR)).vendor_first_seen).toBe(new Date(BASE).toISOString());
	});

	// Paging is only safe if the order is total. An hour with many domains has
	// many rows sharing a window_start, and ordering on window_start alone lets
	// Postgres return them in any order it likes, so a page boundary landing
	// inside such a group can repeat or skip rows. That is why the query
	// tie-breaks on `domain`.
	//
	// The fixture makes both failures visible. All 100 domains first appear in
	// hour 0 and then recur for eleven more hours, so a SKIPPED hour-0 row does
	// not vanish — it resurfaces as a later first_seen, which is exactly the
	// "long-standing customer looks invented this morning" error this module
	// exists to prevent. A REPEAT shows up in the count.
	it("neither repeats nor skips a row across a page boundary", async () => {
		await seedRollups(1200, { domainsPerHour: 100 });

		const arrivals = await domainArrivals(VENDOR);
		const hourZero = new Date(BASE).toISOString();

		expect(arrivals.first_seen).toHaveLength(100);
		expect(arrivals.first_seen.every((seen) => seen === hourZero)).toBe(true);
		expect(requests).toBeGreaterThan(1);
	});

	// A paged read has to be indistinguishable from an unpaged one below the
	// cap, or the fix costs more than the bug did.
	it("returns exactly what a single unpaged read would for a small table", async () => {
		await seedRollups(3, { domainsPerHour: 3 });

		const arrivals = await domainArrivals(VENDOR);
		expect(arrivals.first_seen).toHaveLength(3);
		expect(arrivals.vendor_first_seen).toBe(new Date(BASE).toISOString());
	});

	it("is empty, not partial, when the vendor has nothing", async () => {
		expect(await domainArrivals(VENDOR)).toEqual({ vendor_first_seen: null, first_seen: [] });
	});
});

describe("currentSnapshot, over the row cap", () => {
	// sessions_30d is signed and hash-chained. A prefix here is a signature over
	// a number that understates its own evidence.
	it("sums every session row rather than the first page of them", async () => {
		await seedRollups(OVER_CAP, { sessions: 2 });

		expect(await unpagedCount("hot_rollups")).toBe(MAX_ROWS);

		const snapshot = await currentSnapshot(VENDOR, DOMAIN);
		expect(snapshot.sessions_30d).toBe(OVER_CAP * 2);
		expect(snapshot.observed).toBe(true);
		expect(snapshot.readOk).toBe(true);
	});

	it("matches an unpaged read exactly for a small table", async () => {
		await seedRollups(3, { sessions: 7 });

		expect((await currentSnapshot(VENDOR, DOMAIN)).sessions_30d).toBe(21);
	});

	// The distinction proofs.ts gates the published tier on: no rows is an
	// absence of measurement, not a measured zero.
	it("reports not-observed rather than a confident zero when there are no rows", async () => {
		expect(await currentSnapshot(VENDOR, DOMAIN)).toMatchObject({ sessions_30d: 0, observed: false, readOk: true });
	});
});

describe("fraudFeatures, over the row cap", () => {
	// hourly_buckets drives the countersigner's burst and concentration checks,
	// and those compare SHARES. Truncate the tail and every share is
	// renormalised against a smaller total, which moves the gate.
	it("builds one bucket per rollup row, past the cap", async () => {
		await seedRollups(OVER_CAP, { sessions: 3 });

		const features = await fraudFeatures(VENDOR, "acme-corp", DOMAIN);
		expect(features.hourly_buckets).toHaveLength(OVER_CAP);
		expect(features.events.sessions).toBe(OVER_CAP * 3);
	});

	// The vendor-wide form, which backs the aggregate attestation. It applies
	// one filter rather than two and covers every domain at once, so of
	// everything reading hot_rollups it reaches the cap first.
	it("covers every domain for the vendor-wide form", async () => {
		await seedRollups(OVER_CAP, { domainsPerHour: 40 });

		const features = await fraudFeatures(VENDOR, "*aggregate*", null);
		expect(features.hourly_buckets).toHaveLength(OVER_CAP);
		expect(features.events.sessions).toBe(OVER_CAP);
	});
});

describe("geoDistribution, over the row cap", () => {
	/** Every row past the cap carries a region no row inside it does, so truncation makes that region disappear entirely. */
	async function seedEvents(count: number) {
		const values: string[] = [];
		const args: unknown[] = [];
		for (let i = 0; i < count; i++) {
			const country = i < MAX_ROWS ? "US" : "GB";
			args.push(VENDOR, DOMAIN, "session", 1, "https://x.example", new Date(BASE + i * 1000).toISOString(), country, "X");
			const n = args.length;
			values.push(`($${n - 7}, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`);
		}
		await pg.query(
			`insert into hot_events (vendor_slug, domain, ev, cfg, origin, receipt_ts, country, region) values ${values.join(", ")}`,
			args,
		);
	}

	// This is the one that was ALREADY truncating in production: lettertrace had
	// 1056 hot_events rows inside the window on 2026-09-10 and the unbounded
	// select returned exactly 1000. hot_events holds raw events rather than
	// hourly rollups, so it crosses the cap roughly a hundred times sooner than
	// anything reading hot_rollups.
	it("counts every event, so a region living entirely past the cap is not invisible", async () => {
		await seedEvents(OVER_CAP);

		expect(await unpagedCount("hot_events")).toBe(MAX_ROWS);

		const geo = await geoDistribution(VENDOR);
		expect(geo.regions["GB-X"]).toBe(OVER_CAP - MAX_ROWS);
		expect(geo.regions["US-X"]).toBe(MAX_ROWS);
		expect(geo.distinctRegions).toBe(2);
	});

	it("matches an unpaged read exactly for a small table", async () => {
		await seedEvents(5);

		expect(await geoDistribution(VENDOR)).toEqual({ regions: { "US-X": 5 }, unknown: 0, distinctRegions: 1 });
	});
});
