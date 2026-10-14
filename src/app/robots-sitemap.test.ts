import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/fixtures/vendors", () => ({ listedVendors: vi.fn() }));

import robots from "./robots";
import sitemap from "./sitemap";
import { headers } from "next/headers";
import { listedVendors } from "@/lib/fixtures/vendors";

const withHost = (host: string) =>
	vi.mocked(headers).mockResolvedValue(new Headers({ host }) as never);

beforeEach(() => {
	vi.clearAllMocks();
	withHost("app.letterprove.com");
});

describe("robots.txt", () => {
	it("lets crawlers read proofs and attestations, fences off only /api/", async () => {
		const r = await robots();
		expect(r.rules).toEqual({ userAgent: "*", allow: "/", disallow: "/api/" });
	});

	it("points at this host's own sitemap, so a preview never advertises production's", async () => {
		expect((await robots()).sitemap).toBe("https://app.letterprove.com/sitemap.xml");
		withHost("localhost:9100");
		expect((await robots()).sitemap).toBe("http://localhost:9100/sitemap.xml");
	});
});

describe("sitemap.xml", () => {
	it("lists every published vendor's proof page", async () => {
		vi.mocked(listedVendors).mockResolvedValue([{ slug: "lettertrace" }, { slug: "acme" }] as never);
		const urls = (await sitemap()).map((e) => e.url);
		expect(urls).toContain("https://app.letterprove.com/proofs/lettertrace");
		expect(urls).toContain("https://app.letterprove.com/proofs/acme");
	});

	it("reads the publication gate, so a private vendor can never be listed", async () => {
		// listedVendors() is the gate; the sitemap must not reach past it to allVendors().
		vi.mocked(listedVendors).mockResolvedValue([]);
		const urls = (await sitemap()).map((e) => e.url);
		expect(urls.some((u) => u.includes("/proofs/"))).toBe(false);
		expect(listedVendors).toHaveBeenCalledOnce();
	});

	it("includes the pages that explain how to check a proof", async () => {
		vi.mocked(listedVendors).mockResolvedValue([]);
		const urls = (await sitemap()).map((e) => e.url);
		expect(urls).toEqual([
			"https://app.letterprove.com/verify",
			"https://app.letterprove.com/keys",
			"https://app.letterprove.com/docs",
		]);
	});
});

describe("sitemap.xml: unlisted vendors", () => {
	it("reads the listing gate, so an unlisted vendor is never in the sitemap", async () => {
		vi.mocked(listedVendors).mockResolvedValue([{ slug: "acme" }] as never);
		const urls = (await sitemap()).map((e) => e.url);
		expect(listedVendors).toHaveBeenCalled();
		expect(urls).not.toContain("https://app.letterprove.com/proofs/letterstory");
	});
});
