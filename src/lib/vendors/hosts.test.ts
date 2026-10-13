import { describe, expect, it } from "vitest";
import { checkHostVerification, classifyHost, hostStatus, hostVerificationHosts } from "./hosts";

const TOKEN = "tok123";
const RECORD = `letterprove-site-verification=${TOKEN}`;

/** A resolver answering from a fixed map; unknown names throw like NXDOMAIN. */
function resolver(records: Record<string, string[]>) {
	return async (host: string) => {
		if (!(host in records)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
		return records[host].map((r) => [r]);
	};
}

describe("classifyHost", () => {
	it("covers a host under the verified registrable domain with the same proof", () => {
		expect(classifyHost("app.acme.com", "acme.com")).toEqual({ ok: true, host: "app.acme.com", proof: "under_verified_domain" });
		expect(classifyHost("https://WWW.acme.com/login", "acme.com")).toMatchObject({ ok: true, host: "www.acme.com", proof: "under_verified_domain" });
	});

	it("covers a host under a verified subdomain", () => {
		expect(classifyHost("eu.app.acme.com", "app.acme.com")).toMatchObject({ ok: true, proof: "under_verified_domain" });
	});

	it("does NOT let a verified subdomain vouch for its siblings or its parent", () => {
		expect(classifyHost("eu.acme.com", "app.acme.com")).toMatchObject({ ok: true, proof: "own_dns" });
		expect(classifyHost("www.acme.com", "app.acme.com")).toMatchObject({ ok: true, proof: "own_dns" });
		expect(classifyHost("acme.com", "app.acme.com")).toMatchObject({ ok: true, proof: "own_dns" });
	});

	it("refuses another company's domain, the verified domain itself, and non-hostnames", () => {
		expect(classifyHost("acme.co", "acme.com")).toMatchObject({ ok: false, error: "domain_not_yours" });
		expect(classifyHost("acme.com.evil.com", "acme.com")).toMatchObject({ ok: false, error: "domain_not_yours" });
		expect(classifyHost("acme.com", "acme.com")).toMatchObject({ ok: false, error: "same_as_domain" });
		expect(classifyHost("localhost", "acme.com")).toMatchObject({ ok: false, error: "invalid_host" });
		expect(classifyHost("", "acme.com")).toMatchObject({ ok: false, error: "invalid_host" });
	});

	it("respects multi-part public suffixes", () => {
		expect(classifyHost("app.acme.co.uk", "acme.co.uk")).toMatchObject({ ok: true, proof: "under_verified_domain" });
		expect(classifyHost("other.co.uk", "acme.co.uk")).toMatchObject({ ok: false, error: "domain_not_yours" });
	});
});

describe("checkHostVerification", () => {
	it("accepts the vendor's record on the host itself", async () => {
		const out = await checkHostVerification("eu.acme.com", TOKEN, resolver({ "_letterprove.eu.acme.com": [RECORD] }));
		expect(out).toMatchObject({ verified: true, host: "_letterprove.eu.acme.com" });
	});

	it("accepts it on the registrable domain, which covers everything beneath", async () => {
		const out = await checkHostVerification("eu.acme.com", TOKEN, resolver({ "_letterprove.acme.com": [RECORD] }));
		expect(out).toMatchObject({ verified: true, host: "_letterprove.acme.com" });
	});

	it("does not accept a record on a sibling, or a different token", async () => {
		expect(await checkHostVerification("eu.acme.com", TOKEN, resolver({ "_letterprove.app.acme.com": [RECORD] }))).toMatchObject({
			verified: false,
		});
		expect(
			await checkHostVerification("eu.acme.com", TOKEN, resolver({ "_letterprove.eu.acme.com": ["letterprove-site-verification=other"] })),
		).toMatchObject({ verified: false, reason: "no-match" });
	});

	it("lists where the record may go", () => {
		expect(hostVerificationHosts("eu.acme.com")).toEqual(["_letterprove.eu.acme.com", "eu.acme.com", "_letterprove.acme.com", "acme.com"]);
		expect(hostVerificationHosts("acme.com")).toEqual(["_letterprove.acme.com", "acme.com"]);
	});
});

describe("hostStatus", () => {
	const base = { created_at: "2026-10-13T00:00:00Z" };
	it("accepts a covered host and asks for nothing", () => {
		const s = hostStatus({ ...base, host: "app.acme.com", proof: "under_verified_domain", verified_at: null }, TOKEN);
		expect(s).toMatchObject({ accepted: true, record: null, record_hosts: [] });
	});

	it("asks an own-DNS host for its record until it checks out", () => {
		const waiting = hostStatus({ ...base, host: "eu.acme.com", proof: "own_dns", verified_at: null }, TOKEN);
		expect(waiting).toMatchObject({ accepted: false, record: RECORD });
		expect(waiting.record_hosts).toContain("_letterprove.eu.acme.com");
		const done = hostStatus({ ...base, host: "eu.acme.com", proof: "own_dns", verified_at: "2026-10-13T01:00:00Z" }, TOKEN);
		expect(done).toMatchObject({ accepted: true, record: null });
	});
});
