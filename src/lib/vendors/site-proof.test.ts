import { describe, expect, it } from "vitest";
import { autoCheckUrl, checkSitePage, decideSiteRecheck, htmlHasAttestKey, isPrivateAddress, normalizeSiteUrl, rowDomainProof } from "./site-proof";

const KEY = "lp_live_acme_123";
const TAG = `<script async src="https://app.letterprove.com/attest.js" data-key="${KEY}"></script>`;
const publicLookup = async () => ["93.184.216.34"];

function html(body: string, status = 200, headers: Record<string, string> = {}) {
	return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

describe("htmlHasAttestKey", () => {
	it("finds attest.js with the vendor's exact key", () => {
		expect(htmlHasAttestKey(`<html><head>${TAG}</head></html>`, KEY)).toBe(true);
		expect(htmlHasAttestKey(`<script data-key="${KEY}" src="//app.letterprove.com/attest.js?v=2"></script>`, KEY)).toBe(true);
	});
	it("refuses another key, another script, or the key outside a script tag", () => {
		expect(htmlHasAttestKey(TAG.replace(KEY, "lp_live_other"), KEY)).toBe(false);
		expect(htmlHasAttestKey(`<script src="https://lettervisit.com/v.js" data-key="${KEY}"></script>`, KEY)).toBe(false);
		expect(htmlHasAttestKey(`<p data-key="${KEY}">app.letterprove.com/attest.js</p>`, KEY)).toBe(false);
	});
});

describe("normalizeSiteUrl", () => {
	it("accepts https pages on the domain or a host beneath it", () => {
		expect(normalizeSiteUrl("https://app.acme.com/login#x", "acme.com")).toEqual({ ok: true, url: "https://app.acme.com/login", host: "app.acme.com" });
		expect(normalizeSiteUrl("acme.com", "acme.com")).toMatchObject({ ok: true, url: "https://acme.com/" });
	});
	it("refuses http, another domain, a lookalike, and credentials or ports", () => {
		expect(normalizeSiteUrl("http://acme.com/", "acme.com")).toMatchObject({ ok: false, error: "not_https" });
		expect(normalizeSiteUrl("https://evil.com/", "acme.com")).toMatchObject({ ok: false, error: "not_your_domain" });
		expect(normalizeSiteUrl("https://notacme.com/", "acme.com")).toMatchObject({ ok: false, error: "not_your_domain" });
		expect(normalizeSiteUrl("https://u:p@acme.com/", "acme.com")).toMatchObject({ ok: false, error: "invalid_url" });
		expect(normalizeSiteUrl("https://acme.com:8443/", "acme.com")).toMatchObject({ ok: false, error: "invalid_url" });
	});
});

describe("checkSitePage", () => {
	it("verifies when the page carries the tag", async () => {
		const r = await checkSitePage("https://app.acme.com/login", KEY, { fetcher: async () => html(TAG), lookup: publicLookup });
		expect(r).toMatchObject({ verified: true, answered: true });
	});
	it("is an answered miss when the page loads without the tag", async () => {
		const r = await checkSitePage("https://acme.com/", KEY, { fetcher: async () => html("<html></html>"), lookup: publicLookup });
		expect(r).toMatchObject({ verified: false, answered: true });
	});
	it("never fetches a host that resolves to a private address (SSRF)", async () => {
		let fetched = false;
		const r = await checkSitePage("https://internal.acme.com/", KEY, {
			fetcher: async () => {
				fetched = true;
				return html(TAG);
			},
			lookup: async () => ["10.0.0.5"],
		});
		expect(fetched).toBe(false);
		expect(r).toMatchObject({ verified: false, answered: false });
	});
	it("re-checks every redirect hop against the guard", async () => {
		const hops: string[] = [];
		const r = await checkSitePage("https://acme.com/", KEY, {
			fetcher: async (u) => {
				hops.push(String(u));
				return new Response(null, { status: 302, headers: { location: "https://intranet.acme.com/" } });
			},
			lookup: async (h) => (h === "intranet.acme.com" ? ["192.168.1.2"] : ["93.184.216.34"]),
		});
		expect(hops).toEqual(["https://acme.com/"]);
		expect(r.verified).toBe(false);
	});
	it("refuses a redirect off the registrable domain", async () => {
		const r = await checkSitePage("https://acme.com/", KEY, {
			fetcher: async () => new Response(null, { status: 302, headers: { location: "https://evil.com/" } }),
			lookup: publicLookup,
		});
		expect(r).toMatchObject({ verified: false, answered: true });
	});
	it("doesn't count a failed fetch as an answer", async () => {
		const r = await checkSitePage("https://acme.com/", KEY, {
			fetcher: async () => {
				throw new Error("timeout");
			},
			lookup: publicLookup,
		});
		expect(r).toMatchObject({ verified: false, answered: false });
	});
});

describe("isPrivateAddress", () => {
	it("flags private, loopback, link-local and CGNAT addresses", () => {
		for (const a of ["10.1.2.3", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.0.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
			expect(isPrivateAddress(a)).toBe(true);
		}
		expect(isPrivateAddress("93.184.216.34")).toBe(false);
	});
});

describe("decideSiteRecheck", () => {
	const now = new Date("2026-10-20T00:00:00Z");
	const miss = { verified: false, checked_url: "https://acme.com/", reason: "", answered: true };
	it("clears only after three answered misses over two days", () => {
		expect(decideSiteRecheck({ site_check_failures: 1, site_failing_since: "2026-10-19T00:00:00Z" }, miss, now).cleared).toBe(false);
		expect(decideSiteRecheck({ site_check_failures: 2, site_failing_since: "2026-10-19T12:00:00Z" }, miss, now).cleared).toBe(false);
		const d = decideSiteRecheck({ site_check_failures: 2, site_failing_since: "2026-10-17T00:00:00Z" }, miss, now);
		expect(d.cleared).toBe(true);
		expect(d.patch.site_verified_at).toBeNull();
	});
	it("never counts an unanswered check, and a pass resets the run", () => {
		expect(decideSiteRecheck({ site_check_failures: 2, site_failing_since: "2026-10-10T00:00:00Z" }, { ...miss, answered: false }, now)).toEqual({
			cleared: false,
			patch: { site_checked_at: now.toISOString() },
		});
		expect(decideSiteRecheck({ site_check_failures: 2, site_failing_since: "2026-10-10T00:00:00Z" }, { ...miss, verified: true }, now).patch).toMatchObject({
			site_check_failures: 0,
			site_failing_since: null,
		});
	});
});

describe("autoCheckUrl", () => {
	it("prefers a full Referer on the domain, else the origin's root", () => {
		expect(autoCheckUrl("https://app.acme.com", "https://app.acme.com/login?next=/", "acme.com")).toBe("https://app.acme.com/login?next=/");
		expect(autoCheckUrl("https://app.acme.com", null, "acme.com")).toBe("https://app.acme.com/");
	});
	it("tries nothing off the domain", () => {
		expect(autoCheckUrl("https://evil.com", "https://evil.com/x", "acme.com")).toBeNull();
		expect(autoCheckUrl(null, null, "acme.com")).toBeNull();
	});
});

describe("rowDomainProof", () => {
	it("prefers DNS, then site", () => {
		expect(rowDomainProof({ domain_verified_at: "x", site_verified_at: "y" })).toBe("dns");
		expect(rowDomainProof({ domain_verified_at: null, site_verified_at: "y" })).toBe("site");
		expect(rowDomainProof({})).toBe("none");
	});
});
