import { describe, expect, it, vi } from "vitest";
import { fetchLogoPage, matchOnPage, parseLogoWallInput, publicLogos, statusOf, type LogoWallRow } from "./logo-wall";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn(() => null) }));

describe("parseLogoWallInput", () => {
	const hosts = new Set<string>(["acme.io"]);
	it("accepts a page on the verified domain, beneath it, or an accepted host", () => {
		for (const url of ["https://acme.com/customers", "https://www.acme.com/", "https://acme.io/logos"]) {
			const r = parseLogoWallInput({ page_url: url, companies: [{ name: "Globex", domain: "globex.com" }] }, "acme.com", hosts);
			expect(r.ok).toBe(true);
		}
	});
	it("refuses a page on someone else's site, or not https", () => {
		expect(parseLogoWallInput({ page_url: "https://evil.com/acme", companies: [{ name: "G", domain: "globex.com" }] }, "acme.com", hosts)).toMatchObject({ ok: false, error: "page_not_yours" });
		expect(parseLogoWallInput({ page_url: "http://acme.com/", companies: [{ name: "G", domain: "globex.com" }] }, "acme.com", hosts)).toMatchObject({ ok: false, error: "invalid_page_url" });
	});
	it("refuses free mail as a logo, and dedupes domains", () => {
		expect(parseLogoWallInput({ page_url: "https://acme.com/", companies: [{ name: "Gmail", domain: "gmail.com" }] }, "acme.com", hosts)).toMatchObject({ ok: false, error: "not_a_company" });
		const r = parseLogoWallInput({ page_url: "https://acme.com/", companies: [{ name: "Globex", domain: "Globex.com" }, { name: "Globex Inc", domain: "globex.com" }] }, "acme.com", hosts);
		expect(r.ok && r.companies).toEqual([{ name: "Globex", domain: "globex.com" }]);
	});
});

describe("matchOnPage", () => {
	const companies = [
		{ name: "Globex", domain: "globex.com" },
		{ name: "Initech", domain: "initech.io" },
		{ name: "Credal", domain: "credal.ai" },
		{ name: "Hooli", domain: "hooli.xyz" },
	];
	it("finds a company by visible name, alt text, domain, or logo filename", () => {
		const html = `<html><body><h2>Trusted by</h2><span>Globex</span>
			<img alt="Initech logo" src="/x.png"><a href="https://hooli.xyz">x</a>
			<img src="/logos/credal-wordmark.svg"></body></html>`;
		expect([...matchOnPage(html, companies)].sort()).toEqual(["credal.ai", "globex.com", "hooli.xyz", "initech.io"]);
	});
	it("does not count a name that only appears inside a script, or inside another word", () => {
		const html = `<script>var list=["Globex"]</script><p>Initechnology</p>`;
		expect(matchOnPage(html, companies).size).toBe(0);
	});
});

describe("fetchLogoPage", () => {
	it("follows a redirect within the same registrable domain only", async () => {
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u === "https://acme.com/customers") return new Response(null, { status: 301, headers: { location: "https://www.acme.com/customers" } });
			if (u === "https://www.acme.com/customers") return new Response("<p>Globex</p>", { status: 200 });
			return new Response(null, { status: 404 });
		}) as unknown as typeof fetch;
		expect(await fetchLogoPage("https://acme.com/customers", fetcher)).toEqual({ ok: true, html: "<p>Globex</p>" });

		const offsite = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.com/" } })) as unknown as typeof fetch;
		expect(await fetchLogoPage("https://acme.com/customers", offsite)).toMatchObject({ ok: false });
	});
});

describe("publicLogos", () => {
	const wall: LogoWallRow = {
		page_url: "https://acme.com/customers",
		checked_at: new Date().toISOString(),
		check_error: null,
		companies: [
			{ name: "Globex", domain: "globex.com", on_page: true },
			{ name: "Initech", domain: "initech.io", on_page: true },
			{ name: "Hooli", domain: "hooli.xyz", on_page: true },
			{ name: "Secret Co", domain: "secret.co", on_page: false },
		],
	};
	const observed = new Set(["globex.com", "initech.io", "secret.co"]);
	const paying = new Set(["globex.com", "secret.co"]);

	it("names only companies that are on the page AND observed; counts the rest", () => {
		const block = publicLogos(wall, observed, paying)!;
		expect(block).toEqual({
			page: "https://acme.com/customers",
			listed: 4,
			on_page: 3,
			verified: 2,
			companies: [
				{ name: "Globex", domain: "globex.com", status: "paying" },
				{ name: "Initech", domain: "initech.io", status: "active" },
			],
		});
		// Observed and paying, but not on the vendor's public page: never named.
		expect(JSON.stringify(block)).not.toContain("secret");
		// On the page but never observed: never named.
		expect(JSON.stringify(block)).not.toContain("hooli");
	});

	it("publishes nothing when the page was never checked or the check is stale", () => {
		expect(publicLogos({ ...wall, checked_at: null }, observed, paying)).toBeNull();
		expect(publicLogos({ ...wall, checked_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }, observed, paying)).toBeNull();
		expect(publicLogos(null, observed, paying)).toBeNull();
	});

	it("grades status from evidence alone", () => {
		expect(statusOf("a.com", new Set(["a.com"]), new Set(["a.com"]))).toBe("paying");
		expect(statusOf("a.com", new Set(["a.com"]), new Set())).toBe("active");
		expect(statusOf("a.com", new Set(), new Set(["a.com"]))).toBe("not_observed");
	});
});

describe("logo wall on a separately proven domain", () => {
	it("accepts a page on a domain the vendor proved with its TXT record", async () => {
		const { parseLogoWallInput, provenLogoDomain } = await import("./logo-wall");
		const resolver = async (host: string) => (host === "_letterprove.letter.dev" ? [["letterprove-site-verification=tok"]] : []);
		const proven = await provenLogoDomain("www.letter.dev", "tok", resolver as never);
		expect(proven).toBe("letter.dev");
		const ok = parseLogoWallInput({ page_url: "https://letter.dev/", companies: [{ name: "Acme", domain: "acme.com" }] }, "letterstory.com", new Set(), new Set([proven!]));
		expect(ok.ok).toBe(true);
		const no = parseLogoWallInput({ page_url: "https://letter.dev/", companies: [{ name: "Acme", domain: "acme.com" }] }, "letterstory.com", new Set());
		expect(no).toMatchObject({ ok: false, error: "page_not_yours" });
		expect(await provenLogoDomain("evil.dev", "tok", resolver as never)).toBeNull();
	});
});
