import { describe, expect, it } from "vitest";
import { checkSite, decideSiteRecheck, htmlHasKey, isPrivateAddress, MIN_FAILING_MS } from "./site-verify";

const KEY = "lp_live_acme_1234abcd";
const PUBLIC = async () => ["93.184.216.34"];

function fetcherFrom(pages: Record<string, Response | (() => Response) | Error>): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		const page = pages[url];
		if (page === undefined) return new Response("not found", { status: 404 });
		if (page instanceof Error) throw page;
		return typeof page === "function" ? page() : page.clone();
	}) as typeof fetch;
}

describe("htmlHasKey", () => {
	it("finds the key on the Visitors tag and on the Letterprove tag", () => {
		expect(htmlHasKey(`<script src="https://lettervisit.com/v.js" data-key="${KEY}"></script>`, KEY)).toBe(true);
		expect(htmlHasKey(`<script async data-key='${KEY}' src="//app.letterprove.com/attest.js?v=2"></script>`, KEY)).toBe(true);
	});

	it("needs both our src and the exact key on the same tag", () => {
		expect(htmlHasKey(`<script src="https://evil.example/v.js" data-key="${KEY}"></script>`, KEY)).toBe(false);
		expect(htmlHasKey(`<script src="https://lettervisit.com/v.js" data-key="lp_live_other_1"></script>`, KEY)).toBe(false);
		expect(htmlHasKey(`<script src="https://lettervisit.com/v.js"></script><p data-key="${KEY}">`, KEY)).toBe(false);
		expect(htmlHasKey(`<!-- ${KEY} -->`, KEY)).toBe(false);
	});
});

describe("isPrivateAddress", () => {
	it("refuses loopback, private, link-local, CGNAT and v6 local addresses", () => {
		for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
			expect(isPrivateAddress(a), a).toBe(true);
		}
		for (const a of ["93.184.216.34", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(a), a).toBe(false);
	});
});

describe("checkSite", () => {
	it("passes when the homepage carries the key", async () => {
		const out = await checkSite("acme.com", KEY, {
			lookup: PUBLIC,
			fetcher: fetcherFrom({ "https://acme.com/": new Response(`<script src="https://lettervisit.com/v.js" data-key="${KEY}"></script>`) }),
		});
		expect(out).toMatchObject({ verified: true, checked_url: "https://acme.com/", answered: true });
	});

	it("falls back to www when the bare domain doesn't carry it", async () => {
		const out = await checkSite("acme.com", KEY, {
			lookup: PUBLIC,
			fetcher: fetcherFrom({
				"https://acme.com/": new Response("<html></html>"),
				"https://www.acme.com/": new Response(`<script src="https://app.letterprove.com/attest.js" data-key="${KEY}"></script>`),
			}),
		});
		expect(out).toMatchObject({ verified: true, checked_url: "https://www.acme.com/" });
	});

	it("fails, as a real miss, when the page answers without the key", async () => {
		const out = await checkSite("acme.com", KEY, { lookup: PUBLIC, fetcher: fetcherFrom({ "https://acme.com/": new Response("<html></html>"), "https://www.acme.com/": new Response("<html></html>") }) });
		expect(out).toMatchObject({ verified: false, answered: true });
		expect(out.reason).toMatch(/isn't on/);
	});

	it("follows a redirect within the domain but not off it", async () => {
		const within = await checkSite("acme.com", KEY, {
			lookup: PUBLIC,
			fetcher: fetcherFrom({
				"https://acme.com/": () => new Response(null, { status: 301, headers: { location: "https://www.acme.com/home" } }),
				"https://www.acme.com/home": new Response(`<script src="https://lettervisit.com/v.js" data-key="${KEY}"></script>`),
			}),
		});
		expect(within.verified).toBe(true);

		const off = await checkSite("acme.com", KEY, {
			lookup: PUBLIC,
			fetcher: fetcherFrom({
				"https://acme.com/": () => new Response(null, { status: 302, headers: { location: "https://someone-else.com/" } }),
				"https://www.acme.com/": () => new Response(null, { status: 302, headers: { location: "https://someone-else.com/" } }),
				"https://someone-else.com/": new Response(`<script src="https://lettervisit.com/v.js" data-key="${KEY}"></script>`),
			}),
		});
		expect(off.verified).toBe(false);
		expect(off.reason).toMatch(/redirects off/);
	});

	it("never fetches a name that resolves to a private address, or an IP literal", async () => {
		let fetched = 0;
		const fetcher = (async () => {
			fetched++;
			return new Response(`<script src="https://lettervisit.com/v.js" data-key="${KEY}"></script>`);
		}) as unknown as typeof fetch;
		const priv = await checkSite("intranet.acme.com", KEY, { lookup: async () => ["10.0.0.5"], fetcher });
		expect(priv).toMatchObject({ verified: false, answered: false });
		expect(priv.reason).toMatch(/private address/);
		const literal = await checkSite("169.254.169.254", KEY, { lookup: PUBLIC, fetcher });
		expect(literal.verified).toBe(false);
		expect(fetched).toBe(0);
	});

	it("treats a fetch that couldn't run as unanswered", async () => {
		const out = await checkSite("www.acme.com", KEY, { lookup: PUBLIC, fetcher: fetcherFrom({ "https://www.acme.com/": new Error("timeout") }) });
		expect(out).toMatchObject({ verified: false, answered: false });
	});
});

describe("decideSiteRecheck", () => {
	const t0 = new Date("2026-10-14T04:30:00Z");
	const miss = { verified: false, checked_url: "https://acme.com/", reason: "gone", answered: true };

	it("clears only after three answered misses spanning two days", () => {
		let state = { site_verified_at: "2026-10-01T00:00:00Z", site_check_failures: 0, site_failing_since: null as string | null };
		const d1 = decideSiteRecheck(state, miss, t0);
		expect(d1.cleared).toBe(false);
		state = { ...state, site_check_failures: 2, site_failing_since: t0.toISOString() };
		expect(decideSiteRecheck(state, miss, new Date(t0.getTime() + 60_000)).cleared).toBe(false);
		const d3 = decideSiteRecheck(state, miss, new Date(t0.getTime() + MIN_FAILING_MS));
		expect(d3.cleared).toBe(true);
		expect(d3.patch.site_verified_at).toBeNull();
	});

	it("doesn't count a check that couldn't run, and resets on a pass", () => {
		const state = { site_verified_at: "x", site_check_failures: 2, site_failing_since: t0.toISOString() };
		expect(decideSiteRecheck(state, { ...miss, answered: false }, t0).patch).toEqual({ site_checked_at: t0.toISOString() });
		expect(decideSiteRecheck(state, { ...miss, verified: true }, t0).patch).toMatchObject({ site_check_failures: 0, site_failing_since: null });
	});
});
