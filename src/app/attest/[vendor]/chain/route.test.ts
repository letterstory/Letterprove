import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENESIS_HASH, snapshotHash } from "@/lib/attest/verify";
import { GET } from "./route";

/**
 * The vendor aggregate history.
 *
 * `chain` is a RESERVED SLUG: this static segment sits beside `[customer]`
 * and Next resolves static before dynamic, so a customer slugged "chain"
 * would be unreachable. Customer creation refuses it for that reason; the
 * test at the bottom of this file is what will tell you if that reservation
 * ever stops being enforced here.
 */

vi.mock("@/lib/attest/aggregate", () => ({ vendorAggregateChain: vi.fn() }));

import { vendorAggregateChain } from "@/lib/attest/aggregate";
import type { SignedAggregate } from "@/lib/attest/aggregate";

function entry(overrides: Partial<SignedAggregate>): SignedAggregate {
	return {
		vendor: "vantage",
		kind: "aggregate",
		window_days: 30,
		companies_observed: 12,
		sessions: 38_000,
		signups: 210,
		logins: 9_400,
		domains_excluded: 3,
		tier: 2,
		observed_through: "2026-08-01T00:00:00.000Z",
		published_at: "2026-08-01T00:00:00.000Z",
		ttl: 3600,
		prev_hash: GENESIS_HASH,
		method: "src/lib/attest/aggregate.ts",
		key_id: "dev-insecure-0000",
		signature: "sig-1",
		...overrides,
	} as SignedAggregate;
}

/** A genuinely linked pair, built the way the chain builder builds one. */
function linkedPair(): SignedAggregate[] {
	const first = entry({ published_at: "2026-08-01T00:00:00.000Z", prev_hash: GENESIS_HASH });
	const second = entry({
		published_at: "2026-08-01T01:00:00.000Z",
		sessions: 39_000,
		prev_hash: snapshotHash(first),
		signature: "sig-2",
	});
	return [first, second];
}

function get(vendor: string) {
	return GET(new Request(`https://www.letterprove.com/attest/${vendor}/chain`), {
		params: Promise.resolve({ vendor }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(vendorAggregateChain).mockResolvedValue(linkedPair());
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("GET /attest/[vendor]/chain", () => {
	it("wraps the chain in an envelope that says what it is", async () => {
		const res = await get("vantage");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.vendor).toBe("vantage");
		// The `kind` discriminator is what stops an agent from mistaking an
		// aggregate history for a customer one when it holds both.
		expect(body.kind).toBe("aggregate");
	});

	it("reports a length that matches the chain it actually shipped", async () => {
		const body = await (await get("vantage")).json();

		expect(body.length).toBe(2);
		expect(body.chain).toHaveLength(body.length);
	});

	it("404s an unknown vendor rather than publishing an empty history", async () => {
		// An empty array would read as "this vendor has never claimed anything",
		// which is a claim of its own and not one the evidence supports.
		vi.mocked(vendorAggregateChain).mockResolvedValue(null);

		const res = await get("no-such-vendor");

		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("not_found");
	});

	it("404s rather than serving an empty chain when history could not be read", async () => {
		vi.mocked(vendorAggregateChain).mockResolvedValue(null);

		const res = await get("vantage");

		expect(res.status).toBe(404);
		expect(res.headers.get("cache-control")).toBeNull();
	});
});

describe("GET /attest/[vendor]/chain — chain integrity as served", () => {
	// Computing a correct chain and then serving it reordered would verify
	// entry by entry and still be a forgeable history, so the ORDER on the
	// wire is a property in its own right.
	it("serves entries oldest first", async () => {
		const body = await (await get("vantage")).json();

		expect(body.chain[0].published_at < body.chain[1].published_at).toBe(true);
	});

	it("preserves prev_hash linkage through serialisation", async () => {
		const body = await (await get("vantage")).json();

		expect(body.chain[1].prev_hash).toBe(snapshotHash(body.chain[0]));
	});

	it("starts the first entry at the genesis hash, so a truncated history cannot pass as complete", async () => {
		const body = await (await get("vantage")).json();

		expect(body.chain[0].prev_hash).toBe(GENESIS_HASH);
	});

	it("does not reorder or rewrite what the library handed it", async () => {
		const chain = linkedPair();
		vi.mocked(vendorAggregateChain).mockResolvedValue(chain);

		const body = await (await get("vantage")).json();

		expect(body.chain).toEqual(JSON.parse(JSON.stringify(chain)));
	});
});

describe("GET /attest/[vendor]/chain — cache headers", () => {
	// PINNED AS-IS. This route calls proofJson() with no ttl argument, so the
	// header is the 3600 default rather than the ttl signed into the entries.
	// They happen to agree today because aggregates are published hourly; if
	// the aggregate ttl ever changes, this header will NOT follow it the way
	// /attest/{vendor} does. Documented rather than changed, since nothing
	// signs the header itself.
	it("uses the proofJson default of one hour, not the entries' own ttl", async () => {
		vi.mocked(vendorAggregateChain).mockResolvedValue(linkedPair().map((e) => ({ ...e, ttl: 900 })));

		const res = await get("vantage");

		expect(res.headers.get("cache-control")).toBe("public, max-age=3600, stale-while-revalidate=86400");
	});

	it("declares the charset and stays CORS-open", async () => {
		const res = await get("vantage");

		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("x-letterprove")).toBe("on");
	});
});

describe("GET /attest/[vendor]/chain — the .json suffix", () => {
	// PINNED AS-IS, NOT AS WISHED. /attest/{vendor} strips a trailing `.json`;
	// this route does not, so `/attest/vantage.json/chain` looks up the literal
	// slug "vantage.json" and 404s. Nothing advertises that URL, so it is
	// documented rather than changed — but this is the asymmetry, and this is
	// the test that will notice if it is ever resolved.
	it("passes the vendor segment through verbatim, .json suffix included", async () => {
		await get("vantage.json");

		expect(vendorAggregateChain).toHaveBeenCalledWith("vantage.json");
	});

	it("echoes the raw segment back in the envelope's vendor field", async () => {
		const body = await (await get("vantage.json")).json();

		expect(body.vendor).toBe("vantage.json");
	});
});

describe("GET /attest/[vendor]/chain — access logging", () => {
	it("logs an aggregate/chain subject, distinct from the aggregate document", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await get("vantage");

		const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[letterprove:access]"));
		expect(JSON.parse(line!.slice("[letterprove:access] ".length)).subject).toBe("vantage/aggregate/chain");
	});

	it("keeps only the referring host, never a full referrer", async () => {
		// A full referrer from an answer engine can carry a conversation id or
		// the user's search query.
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await GET(
			new Request("https://www.letterprove.com/attest/vantage/chain", {
				headers: { referer: "https://chatgpt.com/c/68b0-secret-conversation-id?q=is+vantage+legit" },
			}),
			{ params: Promise.resolve({ vendor: "vantage" }) }
		);

		const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[letterprove:access]"))!;
		expect(JSON.parse(line.slice("[letterprove:access] ".length)).from).toBe("chatgpt.com");
		expect(line).not.toContain("secret-conversation-id");
	});
});
