import { describe, expect, it, vi } from "vitest";
import { decideRecheck, recheckAllDomains, recheckResolver, type RecheckState } from "./dns-recheck";
import { expectedRecord } from "./verification";

const NOW = new Date("2026-10-13T04:30:00Z");
const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

const clean: RecheckState = {
	domain_verified_at: "2026-10-01T00:00:00Z",
	domain_dns_failures: 0,
	domain_dns_failing_since: null,
};

describe("decideRecheck", () => {
	it("a present record resets any run of misses", () => {
		const d = decideRecheck(
			{ ...clean, domain_dns_failures: 2, domain_dns_failing_since: hoursBefore(30) },
			{ verified: true, host: "_letterprove.acme.com" },
			NOW,
		);
		expect(d.kind).toBe("present");
		expect(d.patch).toEqual({
			domain_dns_checked_at: NOW.toISOString(),
			domain_dns_failures: 0,
			domain_dns_failing_since: null,
		});
	});

	it("a first miss starts the run but keeps verification", () => {
		const d = decideRecheck(clean, { verified: false, reason: "no-records", found: [] }, NOW);
		expect(d.kind).toBe("missed");
		expect(d.kind === "missed" && d.unverified).toBe(false);
		expect(d.patch).toMatchObject({ domain_dns_failures: 1, domain_dns_failing_since: NOW.toISOString() });
		expect(d.patch).not.toHaveProperty("domain_verified_at");
	});

	it("a wrong record counts as a miss, same as no record", () => {
		const d = decideRecheck(clean, { verified: false, reason: "no-match", found: ["something-else"] }, NOW);
		expect(d.kind).toBe("missed");
	});

	it("the third miss over two days clears verification", () => {
		const d = decideRecheck(
			{ ...clean, domain_dns_failures: 2, domain_dns_failing_since: hoursBefore(48) },
			{ verified: false, reason: "no-records", found: [] },
			NOW,
		);
		expect(d.kind === "missed" && d.unverified).toBe(true);
		expect(d.patch).toMatchObject({ domain_verified_at: null, domain_dns_failures: 3 });
	});

	it("three misses inside two days (a cron firing repeatedly) do not clear it", () => {
		const d = decideRecheck(
			{ ...clean, domain_dns_failures: 2, domain_dns_failing_since: hoursBefore(2) },
			{ verified: false, reason: "no-records", found: [] },
			NOW,
		);
		expect(d.kind === "missed" && d.unverified).toBe(false);
		expect(d.patch).not.toHaveProperty("domain_verified_at");
	});

	it("an unreachable resolver neither counts nor resets", () => {
		const d = decideRecheck(
			{ ...clean, domain_dns_failures: 2, domain_dns_failing_since: hoursBefore(60) },
			{ verified: false, reason: "lookup-failed", found: [] },
			NOW,
		);
		expect(d).toEqual({ kind: "unreachable", patch: { domain_dns_checked_at: NOW.toISOString() } });
	});
});

describe("recheckResolver", () => {
	it("reads NXDOMAIN / no-data as an empty answer, and rethrows anything else", async () => {
		const dns = await import("node:dns");
		const spy = vi.spyOn(dns.promises, "resolveTxt");
		spy.mockRejectedValueOnce(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
		await expect(recheckResolver("_letterprove.gone.example")).resolves.toEqual([]);
		spy.mockRejectedValueOnce(Object.assign(new Error("nodata"), { code: "ENODATA" }));
		await expect(recheckResolver("_letterprove.gone.example")).resolves.toEqual([]);
		spy.mockRejectedValueOnce(Object.assign(new Error("servfail"), { code: "ESERVFAIL" }));
		await expect(recheckResolver("_letterprove.flaky.example")).rejects.toThrow("servfail");
		spy.mockRestore();
	});
});

/** A minimal stand-in for the two Supabase calls the run makes. */
function fakeDb(rows: Record<string, unknown>[]) {
	const writes: { id: string; patch: Record<string, unknown> }[] = [];
	const db = {
		from: () => ({
			select: () => ({
				not: () => ({ order: async () => ({ data: rows, error: null }) }),
			}),
			update: (patch: Record<string, unknown>) => ({
				eq: (_col: string, id: string) => ({
					eq: () => ({
						not: async () => {
							writes.push({ id, patch });
							return { error: null };
						},
					}),
				}),
			}),
		}),
	};
	return { db: db as never, writes };
}

describe("recheckAllDomains", () => {
	const row = (slug: string, failures = 0, since: string | null = null) => ({
		id: `id-${slug}`,
		slug,
		domain: `${slug}.example`,
		domain_verification_token: `tok-${slug}`,
		domain_verified_at: "2026-10-01T00:00:00Z",
		domain_dns_failures: failures,
		domain_dns_failing_since: since,
	});

	it("checks every verified vendor and reports who lost verification", async () => {
		const { db, writes } = fakeDb([row("kept"), row("gone", 2, hoursBefore(50)), row("blip")]);
		const resolver = async (host: string) => {
			if (host.endsWith("kept.example")) return [[expectedRecord("tok-kept")]];
			if (host.endsWith("blip.example")) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
			return [];
		};

		const run = await recheckAllDomains(db, resolver, () => NOW);

		expect(run).toMatchObject({ ok: true, checked: 3, present: 1, missed: 1, unreachable: 1, unverified: ["gone"] });
		expect(writes.find((w) => w.id === "id-gone")!.patch).toMatchObject({ domain_verified_at: null });
		expect(writes.find((w) => w.id === "id-kept")!.patch).toMatchObject({ domain_dns_failures: 0 });
		expect(writes.find((w) => w.id === "id-blip")!.patch).toEqual({ domain_dns_checked_at: NOW.toISOString() });
	});

	it("skips, and reports, a verified vendor with no token rather than un-verifying it", async () => {
		const { db, writes } = fakeDb([{ ...row("odd"), domain_verification_token: null }]);
		const run = await recheckAllDomains(db, async () => [], () => NOW);
		expect(run.checked).toBe(0);
		expect(run.errors).toEqual([{ slug: "odd", detail: "verified but has no verification token" }]);
		expect(writes).toEqual([]);
	});
});
