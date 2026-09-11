import { describe, expect, it, vi } from "vitest";
import { createCustomer, updateCustomer, deleteCustomer } from "./customers";

/**
 * Enough of the supabase chain for every shape these functions use: the write
 * chains (insert().select().single(), update/delete().eq().eq().select()
 * .maybeSingle()) and the read chains (select().eq().eq().maybeSingle()), which
 * `updateCustomer` now uses to see the row's subject before it changes it.
 *
 * One chainable node backs all of them rather than a hand-wired tree per shape.
 * The tree version broke the moment a function called `.select()` before `.eq()`
 * instead of after, which said nothing true about the code under test.
 *
 * `vendorDomain` defaults to a non-Letter-Company domain: none of the existing
 * customer-CRUD tests below exercise INTERNAL customer domains, so the vendor's
 * own domain is irrelevant to them either way. It only matters for the
 * domain-gate tests, which override it.
 */
function mockSupabase(row: unknown = { id: "c1", slug: "acme" }, vendorDomain = "acme-vendor.com") {
	const single = vi.fn().mockResolvedValue({ data: row, error: null });
	const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null });
	const node: Record<string, unknown> = {};
	const select = vi.fn(() => node);
	const eq = vi.fn(() => node);
	Object.assign(node, { select, eq, single, maybeSingle });

	const insert = vi.fn((_row: Record<string, unknown>) => node);
	const update = vi.fn((_patch: Record<string, unknown>) => node);
	const del = vi.fn(() => node);

	const vendorMaybeSingle = vi.fn().mockResolvedValue({ data: { domain: vendorDomain }, error: null });
	const vendorEq = vi.fn().mockReturnValue({ maybeSingle: vendorMaybeSingle });
	const vendorSelect = vi.fn().mockReturnValue({ eq: vendorEq });

	const from = vi.fn((table: string) =>
		table === "vendors" ? { select: vendorSelect } : { insert, update, delete: del, select },
	);
	return { from, insert, update, delete: del, select, maybeSingle, vendorMaybeSingle };
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

	/*
	 * The subject of a counter-signature is vendor-writable; the
	 * counter-signature itself must not outlive it.
	 *
	 * `countersigned_at` is correctly not settable through this function, but
	 * that alone left the cheaper forgery open: have one friendly party
	 * countersign honestly, then rename the row into a company that never
	 * approved anything and keep tier 4. Same reasoning as update_vendor
	 * clearing `domain_verified_at` when the domain moves.
	 */
	describe("changing the subject discards what was agreed about it", () => {
		const countersigned = {
			id: "c1",
			slug: "acme",
			name: "Acme Corp",
			domain: "acme.com",
			countersigned_at: "2026-09-01T00:00:00.000Z",
			consent_token: null,
		};

		it("clears the counter-signature and its provenance when the name changes", async () => {
			const db = mockSupabase(countersigned);

			const result = await updateCustomer(db as never, "v1", "acme", { name: "Globex" });

			expect(db.update).toHaveBeenCalledWith(
				expect.objectContaining({ name: "Globex", countersigned_at: null, countersigned_by: null }),
			);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.data.countersignatureCleared).toBe(true);
		});

		it("clears it when the domain changes, which is what tier 4 is bound to", async () => {
			const db = mockSupabase(countersigned);

			await updateCustomer(db as never, "v1", "acme", { domain: "acme-hq.com" });

			expect(db.update).toHaveBeenCalledWith(
				expect.objectContaining({ domain: "acme-hq.com", countersigned_at: null }),
			);
		});

		it("leaves it alone when the update does not touch the subject", async () => {
			const db = mockSupabase(countersigned);

			const result = await updateCustomer(db as never, "v1", "acme", { since: "2024-01" });

			expect(db.update).toHaveBeenCalledWith({ since: "2024-01" });
			if (result.ok) expect(result.data.countersignatureCleared).toBe(false);
		});

		// A PATCH that writes the same values back is not a subject change. Without
		// the comparison, any caller that round-trips the whole row would destroy a
		// counter-signature it never meant to touch.
		it("leaves it alone when name and domain are re-sent unchanged", async () => {
			const db = mockSupabase(countersigned);

			await updateCustomer(db as never, "v1", "acme", { name: "Acme Corp", domain: "acme.com" });

			expect(db.update).toHaveBeenCalledWith({ name: "Acme Corp", domain: "acme.com" });
		});

		// The recipient binding was checked against the domain as it stood when
		// the link was minted, and the consent page showed the name as it stood
		// then. A token that outlives either would let an approval land on a claim
		// its approver was never shown.
		it("invalidates a live consent link, because it was minted for the old subject", async () => {
			const db = mockSupabase({ ...countersigned, countersigned_at: null, consent_token: "tok" });

			const result = await updateCustomer(db as never, "v1", "acme", { domain: "acme-hq.com" });

			expect(db.update).toHaveBeenCalledWith(
				expect.objectContaining({ consent_token: null, consent_token_expires_at: null, consent_sent_to: null }),
			);
			if (result.ok) {
				expect(result.data.pendingConsentCleared).toBe(true);
				expect(result.data.countersignatureCleared).toBe(false);
			}
		});

		// A decline is permanent history and the 30-day cooldown reads from it.
		// Clearing it here would make a one-character rename a cooldown bypass,
		// which is the opposite of what recording a decline was for.
		it("never clears the decline record, so a rename cannot reset the cooldown", async () => {
			const db = mockSupabase({ ...countersigned, consent_token: "tok" });

			await updateCustomer(db as never, "v1", "acme", { name: "Globex" });

			const [patch] = db.update.mock.calls[0];
			expect(patch).not.toHaveProperty("consent_declined_at");
			expect(patch).not.toHaveProperty("consent_decline_count");
		});
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
