import { describe, expect, it, vi } from "vitest";
import { createCustomer, updateCustomer, deleteCustomer } from "./customers";

/**
 * Enough of the supabase chain for insert().select().single(),
 * update/delete().eq().eq().select().maybeSingle(), and the vendors-table
 * read `vendorOwnDomain` does before every domain-gate check
 * (.from("vendors").select("domain").eq("id", ...).maybeSingle()).
 *
 * `vendorDomain` defaults to a non-Letter-Company domain: none of the
 * existing customer-CRUD tests below exercise INTERNAL customer domains, so
 * the vendor's own domain is irrelevant to them either way — it only matters
 * for the domain-gate tests, which override it.
 */
function mockSupabase(row: unknown = { id: "c1", slug: "acme" }, vendorDomain = "acme-vendor.com") {
	const single = vi.fn().mockResolvedValue({ data: row, error: null });
	const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
	const select = vi.fn().mockReturnValue({ single, maybeSingle });
	const eq2 = vi.fn().mockReturnValue({ select });
	const eq1 = vi.fn().mockReturnValue({ eq: eq2, select });
	const insert = vi.fn().mockReturnValue({ select });
	const update = vi.fn().mockReturnValue({ eq: eq1 });
	const del = vi.fn().mockReturnValue({ eq: eq1 });

	const vendorMaybeSingle = vi.fn().mockResolvedValue({ data: { domain: vendorDomain }, error: null });
	const vendorEq = vi.fn().mockReturnValue({ maybeSingle: vendorMaybeSingle });
	const vendorSelect = vi.fn().mockReturnValue({ eq: vendorEq });

	const from = vi.fn((table: string) =>
		table === "vendors" ? { select: vendorSelect } : { insert, update, delete: del },
	);
	return { from, insert, update, delete: del, maybeSingle, vendorMaybeSingle };
}

describe("createCustomer", () => {
	it("rejects missing required fields before touching the db", async () => {
		const db = mockSupabase();
		const result = await createCustomer(db as never, "v1", { slug: "acme", name: "", domain: "acme.com", since: "2024" });
		expect(result).toEqual({ ok: false, status: 400, body: { error: "slug, name, domain, and since are required" } });
		expect(db.from).not.toHaveBeenCalled();
	});

	// "chain" collides with /attest/[vendor]/chain — a customer route reachable
	// at the same path as a published route would shadow it.
	it("refuses a slug that collides with a published route", async () => {
		const db = mockSupabase();
		const result = await createCustomer(db as never, "v1", { slug: "chain", name: "Chain Co", domain: "chain.com", since: "2024" });
		expect(result).toEqual({
			ok: false,
			status: 422,
			body: { error: '"chain" is a reserved slug', reason: "it collides with a published route" },
		});
		expect(db.from).not.toHaveBeenCalled();
	});

	it("defaults consent to anonymous when none is given", async () => {
		const db = mockSupabase();
		await createCustomer(db as never, "v1", { slug: "acme", name: "Acme", domain: "acme.com", since: "2024" });
		expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({ consent: "anonymous", vendor_id: "v1" }));
	});

	describe("domain gate is vendor-scoped", () => {
		it("refuses a Letter Company domain when the caller's own vendor is also ours", async () => {
			const db = mockSupabase({ id: "c1", slug: "letterbrace" }, "lettertrace.com");
			const result = await createCustomer(db as never, "v1", {
				slug: "letterbrace",
				name: "Letterbrace",
				domain: "letterbrace.com",
				since: "2024",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.body.kind).toBe("internal");
			expect(db.insert).not.toHaveBeenCalled();
		});

		it("allows a Letter Company domain as a real customer of a non-Letter-Company vendor", async () => {
			const db = mockSupabase({ id: "c1", slug: "letterbrace" }, "acme-vendor.com");
			const result = await createCustomer(db as never, "v1", {
				slug: "letterbrace",
				name: "Letterbrace",
				domain: "letterbrace.com",
				since: "2024",
			});
			expect(result.ok).toBe(true);
			expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({ domain: "letterbrace.com" }));
		});
	});
});

describe("updateCustomer", () => {
	it("refuses an update with no recognized fields, before touching the db", async () => {
		const db = mockSupabase();
		const result = await updateCustomer(db as never, "v1", "acme", {});
		expect(result).toEqual({ ok: false, status: 400, body: { error: "no updatable fields provided" } });
		expect(db.from).not.toHaveBeenCalled();
	});

	it("drops unrecognized feature flags rather than storing them", async () => {
		const db = mockSupabase();
		await updateCustomer(db as never, "v1", "acme", { features: ["sso", "not_a_real_feature"] });
		expect(db.update).toHaveBeenCalledWith({ features: ["sso"] });
	});

	// A 404 on empty match covers "not found" and "not yours" as one
	// deliberate conflation — never a separate ownership check (see
	// feedback_rls_trust_pattern).
	it("404s when the vendor-scoped match is empty, not just when the db errors", async () => {
		const db = mockSupabase();
		db.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
		const result = await updateCustomer(db as never, "v1", "someone-elses-slug", { name: "New" });
		expect(result).toEqual({ ok: false, status: 404, body: { error: "not_found" } });
	});
});

describe("deleteCustomer", () => {
	it("404s when the vendor-scoped match is empty", async () => {
		const db = mockSupabase();
		db.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
		const result = await deleteCustomer(db as never, "v1", "someone-elses-slug");
		expect(result).toEqual({ ok: false, status: 404, body: { error: "not_found" } });
	});

	it("scopes the delete by both vendor and slug", async () => {
		const db = mockSupabase({ id: "c1" });
		await deleteCustomer(db as never, "v1", "acme");
		expect(db.delete).toHaveBeenCalled();
	});
});
