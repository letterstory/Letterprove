import { describe, expect, it, vi } from "vitest";
import {
	checkDomainVerification,
	expectedRecord,
	verificationHosts,
	verificationMessage,
	type TxtResolver,
} from "./verification";

const TOKEN = "6f1c2b9a4d3e4f5a8b7c6d5e4f3a2b1c";
const RECORD = expectedRecord(TOKEN);

/** A resolver backed by a fixed map; anything absent throws like NXDOMAIN. */
function resolver(zone: Record<string, string[][]>): TxtResolver {
	return async (host) => {
		if (!(host in zone)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
		return zone[host];
	};
}

describe("verificationHosts", () => {
	it("prefers the _letterprove subdomain but accepts the apex", () => {
		expect(verificationHosts("acme.com")).toEqual(["_letterprove.acme.com", "acme.com"]);
	});
});

describe("checkDomainVerification", () => {
	it("verifies from the _letterprove subdomain", async () => {
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({
			"_letterprove.acme.com": [[RECORD]],
		}));
		expect(out).toEqual({ verified: true, host: "_letterprove.acme.com" });
	});

	it("verifies from the apex, where people expect to put it", async () => {
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({
			"acme.com": [[RECORD]],
		}));
		expect(out).toEqual({ verified: true, host: "acme.com" });
	});

	it("finds the record among unrelated TXT records", async () => {
		// An apex TXT set realistically holds SPF, DMARC and other vendors'
		// verifications. Ours has to be found among them, not instead of them.
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({
			"acme.com": [
				["v=spf1 include:_spf.google.com ~all"],
				["google-site-verification=abc123"],
				[RECORD],
			],
		}));
		expect(out.verified).toBe(true);
	});

	it("joins the 255-byte chunks a resolver splits a record into", async () => {
		// dns.resolveTxt returns string[][] — one array per record, already
		// split. Comparing a chunk instead of the joined value would mean a
		// long record never matches, for no visible reason.
		const [a, b] = [RECORD.slice(0, 10), RECORD.slice(10)];
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({
			"_letterprove.acme.com": [[a, b]],
		}));
		expect(out.verified).toBe(true);
	});

	it("tolerates surrounding whitespace", async () => {
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({
			"_letterprove.acme.com": [[`  ${RECORD}  `]],
		}));
		expect(out.verified).toBe(true);
	});

	it("does not verify on another vendor's token", async () => {
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({
			"_letterprove.acme.com": [[expectedRecord("a-different-token")]],
		}));
		expect(out).toMatchObject({ verified: false, reason: "no-match" });
	});

	it("does not verify on the bare token without the prefix", async () => {
		// The prefix is what stops an unrelated TXT value coincidentally
		// matching, so a bare token must not be enough.
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({
			"_letterprove.acme.com": [[TOKEN]],
		}));
		expect(out.verified).toBe(false);
	});

	it("reports no-records when the zone resolves but holds nothing", async () => {
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({ "acme.com": [] }));
		expect(out).toMatchObject({ verified: false, reason: "no-records" });
	});

	it("reports lookup-failed when no host resolves at all", async () => {
		// Distinct from "resolved, but nothing there" — one is probably a typo
		// in the domain, the other is probably DNS still propagating.
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({}));
		expect(out).toMatchObject({ verified: false, reason: "lookup-failed" });
	});

	it("keeps checking after the first host NXDOMAINs", async () => {
		// _letterprove.<domain> not existing is the normal case for a vendor
		// who put the record on the apex. Bailing there would fail them.
		const out = await checkDomainVerification("acme.com", TOKEN, resolver({
			"acme.com": [[RECORD]],
		}));
		expect(out.verified).toBe(true);
	});

	it("never lets one vendor's record verify another's domain", async () => {
		// The token is per-vendor, so publishing yours proves nothing about
		// a domain whose row holds a different one.
		const out = await checkDomainVerification("victim.com", "victim-token", resolver({
			"_letterprove.victim.com": [[expectedRecord("attacker-token")]],
		}));
		expect(out.verified).toBe(false);
	});

	it("does not hit the network by default in tests", async () => {
		// Guard against a future refactor dropping the injected resolver and
		// silently making the suite depend on real DNS.
		const spy = vi.fn().mockRejectedValue(new Error("nope"));
		await checkDomainVerification("acme.com", TOKEN, spy);
		expect(spy).toHaveBeenCalled();
	});
});

describe("verificationMessage", () => {
	it("names the thing the vendor has to change", async () => {
		const missing = await checkDomainVerification("acme.com", TOKEN, resolver({ "acme.com": [] }));
		expect(verificationMessage(missing, "acme.com")).toContain("_letterprove.acme.com");

		const mismatch = await checkDomainVerification("acme.com", TOKEN, resolver({
			"acme.com": [["something-else"]],
		}));
		expect(verificationMessage(mismatch, "acme.com")).toContain("letterprove-site-verification=");
	});
});
