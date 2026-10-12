import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	attachDomain,
	checkCustomDomain,
	customDomainStatus,
	getDomainState,
	isOwnHost,
	registrableDomain,
} from "./custom-domain";

describe("which hostnames a vendor may claim", () => {
	it("accepts a subdomain of the vendor's own registrable domain", () => {
		expect(checkCustomDomain("proof.acme.com", "acme.com")).toEqual({ ok: true, domain: "proof.acme.com" });
		expect(checkCustomDomain("https://Success.Acme.com/", "www.acme.com")).toEqual({ ok: true, domain: "success.acme.com" });
		// A vendor verified on a product host still owns its company's subdomains.
		expect(checkCustomDomain("proof.letterstory.com", "app.letterstory.com")).toMatchObject({ ok: true });
	});

	it("refuses another company's hostname, so nobody can squat a name before its owner points it at us", () => {
		expect(checkCustomDomain("proof.lettertrace.com", "acme.com")).toMatchObject({ ok: false, error: "domain_not_yours" });
		expect(checkCustomDomain("proof.acme.com.evil.io", "acme.com")).toMatchObject({ ok: false, error: "domain_not_yours" });
	});

	it("refuses the apex, our own hosts, and non-hostnames", () => {
		expect(checkCustomDomain("acme.com", "acme.com")).toMatchObject({ ok: false, error: "apex_not_supported" });
		expect(checkCustomDomain("x.letterprove.com", "letterprove.com")).toMatchObject({ ok: false, error: "invalid_domain" });
		expect(checkCustomDomain("not a host", "acme.com")).toMatchObject({ ok: false, error: "invalid_domain" });
	});

	it("knows two-part public suffixes", () => {
		expect(registrableDomain("proof.acme.co.uk")).toBe("acme.co.uk");
		expect(registrableDomain("proof.acme.com")).toBe("acme.com");
		expect(checkCustomDomain("proof.other.co.uk", "acme.co.uk")).toMatchObject({ ok: false, error: "domain_not_yours" });
	});
});

describe("isOwnHost", () => {
	it("treats our hosts and previews as ours and everything else as a vendor's", () => {
		for (const h of ["app.letterprove.com", "letterprove.com", "letterprove-abc.vercel.app", "localhost:9100"]) expect(isOwnHost(h)).toBe(true);
		expect(isOwnHost("proof.acme.com")).toBe(false);
	});
});

describe("customDomainStatus", () => {
	const row = { custom_domain: "proof.acme.com", custom_domain_verified_at: null, proofs_published_at: "2026-10-01T00:00:00Z" };
	const state = { verified: true, misconfigured: true, cnameTarget: "abc.vercel-dns-017.com", verification: [] };

	it("tells the vendor the exact CNAME to add while DNS is not pointed", () => {
		const s = customDomainStatus(row, state);
		expect(s.dns).toEqual({ type: "CNAME", name: "proof.acme.com", value: "abc.vercel-dns-017.com" });
		expect(s.live).toBe(false);
		expect(s.message).toContain("abc.vercel-dns-017.com");
	});

	it("is live only when configured, verified and published", () => {
		expect(customDomainStatus(row, { ...state, misconfigured: false }).live).toBe(true);
		expect(customDomainStatus({ ...row, proofs_published_at: null }, { ...state, misconfigured: false }).live).toBe(false);
	});

	it("answers plainly when no domain is set", () => {
		expect(customDomainStatus({ custom_domain: null, custom_domain_verified_at: null, proofs_published_at: null }, null)).toMatchObject({ domain: null, live: false, dns: null });
	});
});

describe("Vercel calls", () => {
	beforeEach(() => {
		vi.stubEnv("LETTERPROVE_VERCEL_TOKEN", "t");
		vi.stubEnv("LETTERPROVE_VERCEL_PROJECT_ID", "prj_1");
		vi.stubEnv("LETTERPROVE_VERCEL_TEAM_ID", "team_1");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("attaches to this project, and treats already-attached as done", async () => {
		const fetcher = vi.fn(async (url: URL | RequestInfo) => {
			expect(String(url)).toBe("https://api.vercel.com/v10/projects/prj_1/domains?teamId=team_1");
			return new Response(JSON.stringify({ error: { code: "domain_already_in_use" } }), { status: 409 });
		});
		expect(await attachDomain("proof.acme.com", fetcher as unknown as typeof fetch)).toEqual({ ok: true });
	});

	it("reads verification and DNS together, preferring Vercel's recommended CNAME", async () => {
		const fetcher = vi.fn(async (url: URL | RequestInfo) =>
			String(url).includes("/config")
				? new Response(JSON.stringify({ misconfigured: false, recommendedCNAME: [{ rank: 2, value: "b." }, { rank: 1, value: "a.vercel-dns-017.com." }] }))
				: new Response(JSON.stringify({ verified: true, verification: [] })),
		);
		expect(await getDomainState("proof.acme.com", fetcher as unknown as typeof fetch)).toEqual({
			verified: true,
			misconfigured: false,
			cnameTarget: "a.vercel-dns-017.com",
			verification: [],
		});
	});
});
