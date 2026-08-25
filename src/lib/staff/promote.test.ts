import { beforeEach, describe, expect, it, vi } from "vitest";
import { promoteDomain, provisionalName, slugForDomain } from "./promote";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/tiers/report", () => ({ tierReport: vi.fn() }));

type Row = { domain: string; sessions: number; signups: number; logins: number; customer: string | null };

function row(domain: string, over: Partial<Row> = {}): Row {
	return { domain, sessions: 3, signups: 0, logins: 0, customer: null, ...over };
}

/**
 * Captures the insert so tests can assert on what was actually written.
 * `vendorDomain` defaults to something that is never in the INTERNAL set, so
 * existing tests exercising ordinary company domains are unaffected by the
 * vendor-scoped self-dealing check — only the tests that care about it
 * override it.
 */
function mockDb(opts: { vendorId?: string | null; vendorDomain?: string; error?: { code?: string; message: string } } = {}) {
	const insert = vi.fn().mockResolvedValue({ error: opts.error ?? null });
	const maybeSingle = vi.fn().mockResolvedValue({
		data: opts.vendorId === null ? null : { id: opts.vendorId ?? "v1", domain: opts.vendorDomain ?? "acme-vendor.com" },
		error: null,
	});
	const chain = { maybeSingle, eq: () => chain, select: () => chain };
	return { db: { from: vi.fn(() => ({ ...chain, insert })) }, insert };
}

async function setup(rows: Row[], dbOpts?: Parameters<typeof mockDb>[0]) {
	const { tierReport } = await import("@/lib/tiers/report");
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(tierReport).mockResolvedValue({ vendor: "lettertrace", observed: rows.length, attributable: rows.length, unpublishedEvidence: 0, published: 0, rows } as never);
	const { db, insert } = mockDb(dbOpts);
	vi.mocked(dbClient).mockReturnValue(db as never);
	return { insert };
}

beforeEach(() => vi.clearAllMocks());

describe("slugForDomain", () => {
	it("uses the registrable label, not the whole host", () => {
		expect(slugForDomain("globex.com")).toBe("globex");
		expect(slugForDomain("northwind.ai")).toBe("northwind");
	});

	// A two-part public suffix would otherwise leave the country code as the slug.
	it("handles a second-level suffix", () => {
		expect(slugForDomain("am.com.mx")).toBe("am");
		expect(slugForDomain("yourlocaltermiteandpestcontrol.com.au")).toBe("yourlocaltermiteandpestcontrol");
		expect(slugForDomain("news.bbc.co.uk")).toBe("bbc");
	});

	/**
	 * The reason the suffixes are listed instead of guessed by length. "Both
	 * last labels are short" also describes `ibm.com`, so the heuristic version
	 * of this reduced `mail.ibm.com` to "mail" — a subdomain, not the company.
	 */
	it("keeps the registrable label when it is short and carries a subdomain", () => {
		expect(slugForDomain("mail.ibm.com")).toBe("ibm");
		expect(slugForDomain("mail.company.com")).toBe("company");
		expect(slugForDomain("go.hp.com")).toBe("hp");
	});

	// An unlisted suffix drops one label — the same answer as before, never worse.
	it("degrades to dropping the tld for a suffix it does not know", () => {
		expect(slugForDomain("acme.co.zz")).toBe("co");
		expect(slugForDomain("acme.zz")).toBe("acme");
	});

	it("normalises case and a trailing dot", () => {
		expect(slugForDomain("Umbrella.COM.")).toBe("umbrella");
	});

	it("produces a name a human is expected to correct", () => {
		expect(provisionalName("thisisseaweed.com")).toBe("Thisisseaweed");
	});
});

describe("what promotion refuses", () => {
	// The whole point of the domain gate. Promoting gmail.com would put "Gmail"
	// on the path to being a named customer.
	it("refuses a consumer mailbox, without even reading the report", async () => {
		const { tierReport } = await import("@/lib/tiers/report");
		const r = await promoteDomain("lettertrace", "gmail.com");
		expect(r).toMatchObject({ ok: false, reason: "not_attributable" });
		expect(tierReport).not.toHaveBeenCalled();
	});

	// Attesting our own usage is the vendor-asserted circularity the product
	// exists to replace — but only when the promoting vendor is also ours.
	// "lettertrace" is a Letter Company vendor (lettertrace.com), so this is
	// the self-dealing case.
	it("refuses our own domains when the promoting vendor is also ours", async () => {
		await setup([], { vendorDomain: "lettertrace.com" });
		expect(await promoteDomain("lettertrace", "letterstory.com")).toMatchObject({
			ok: false,
			reason: "not_attributable",
			detail: expect.stringContaining("self-dealing"),
		});
	});

	// A genuinely external vendor promoting a real, observed Letter Company
	// visitor into a customer record is not self-dealing — same flow as any
	// other company.
	it("promotes our domain for a vendor that isn't ours", async () => {
		const { insert } = await setup([row("letterstory.com")], { vendorDomain: "acme-vendor.com" });
		const r = await promoteDomain("acme-vendor", "letterstory.com");
		expect(r).toMatchObject({ ok: true, domain: "letterstory.com" });
		expect(insert).toHaveBeenCalled();
	});

	it("refuses a reserved-TLD fixture domain", async () => {
		expect(await promoteDomain("lettertrace", "acme-corp.example")).toMatchObject({
			ok: false,
			reason: "not_attributable",
		});
	});

	// A record with no evidence behind it is a vendor assertion with extra
	// steps, and it would publish as tier 0 anyway.
	it("refuses a domain nothing has been observed for", async () => {
		const { insert } = await setup([row("globex.com", { sessions: 0, signups: 0, logins: 0 })]);
		expect(await promoteDomain("lettertrace", "globex.com")).toMatchObject({ ok: false, reason: "not_observed" });
		expect(insert).not.toHaveBeenCalled();
	});

	it("refuses a domain absent from the report entirely", async () => {
		await setup([row("globex.com")]);
		expect(await promoteDomain("lettertrace", "never-seen.com")).toMatchObject({ ok: false, reason: "not_observed" });
	});

	it("refuses a domain that already has a record", async () => {
		const { insert } = await setup([row("globex.com", { customer: "globex" })]);
		expect(await promoteDomain("lettertrace", "globex.com")).toMatchObject({ ok: false, reason: "already_exists" });
		expect(insert).not.toHaveBeenCalled();
	});

	// A failed telemetry read must not read as "nothing observed" — the report
	// returns null for both, and only one of them is an absence of evidence.
	it("refuses when the report cannot be read at all", async () => {
		await setup([]);
		const { tierReport } = await import("@/lib/tiers/report");
		vi.mocked(tierReport).mockResolvedValue(null);
		expect(await promoteDomain("lettertrace", "globex.com")).toMatchObject({ ok: false, reason: "vendor_unreadable" });
	});

	it("reports a slug collision as a conflict rather than a write failure", async () => {
		await setup([row("globex.com")], { error: { code: "23505", message: "duplicate key" } });
		expect(await promoteDomain("lettertrace", "globex.com")).toMatchObject({ ok: false, reason: "already_exists" });
	});
});

describe("what promotion writes", () => {
	it("creates the record anonymous, never named", async () => {
		const { insert } = await setup([row("globex.com")]);
		await promoteDomain("lettertrace", "globex.com");
		expect(insert.mock.calls[0][0]).toMatchObject({ consent: "anonymous" });
	});

	// tier is a CEILING re-derived by earned() at publish time. Storing
	// verified: true here would make provenance an assertion again.
	it("stores a tier-1 ceiling and never marks it verified", async () => {
		const { insert } = await setup([row("globex.com")]);
		await promoteDomain("lettertrace", "globex.com");
		expect(insert.mock.calls[0][0]).toMatchObject({ tier: 1, verified: false, features: [] });
	});

	it("scopes the record to the vendor it was promoted for", async () => {
		const { insert } = await setup([row("globex.com")], { vendorId: "vendor-abc" });
		await promoteDomain("lettertrace", "globex.com");
		expect(insert.mock.calls[0][0]).toMatchObject({ vendor_id: "vendor-abc", domain: "globex.com" });
	});

	it("normalises the domain before writing it", async () => {
		const { insert } = await setup([row("globex.com")]);
		const r = await promoteDomain("lettertrace", "  Globex.COM.  ");
		expect(r).toMatchObject({ ok: true, slug: "globex", domain: "globex.com" });
		expect(insert.mock.calls[0][0]).toMatchObject({ domain: "globex.com" });
	});
});
