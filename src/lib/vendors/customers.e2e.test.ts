import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase as sharedPgliteSupabase } from "@/lib/test-support/pglite-supabase";

/**
 * customers.test.ts exercises createCustomer/updateCustomer's domain gate
 * against an in-memory fake `.from().insert().select().single()` chain — it
 * proves the code makes the right calls, not that those calls match
 * vendor_customers' and vendors' real schema. This file runs the same,
 * unmodified createCustomer/updateCustomer against a real (embedded, WASM)
 * Postgres with the actual migrations applied — same technique as
 * registry.e2e.test.ts and route.schema.test.ts — so the vendor-scoped
 * self-dealing check (this PR's actual change: classifyDomain now reads the
 * calling vendor's own `domain` column) is proven against the real column it
 * reads, not a mock that could silently drift from the migration.
 *
 * What this specifically has to show, end to end against real rows:
 *   1. An external vendor (domain outside the Letter Company's own set) can
 *      create The Letter Company as a real customer — the feature this PR
 *      exists to unblock — and the row actually lands in vendor_customers.
 *   2. A Letter Company vendor (its own `domain` column is itself internal)
 *      is still refused, and nothing is written — the self-dealing case the
 *      gate exists to prevent stays prevented.
 *   3. The same two outcomes hold for updateCustomer, since gating only
 *      creation would leave the rule trivially bypassable.
 */

let pg: PGlite;

const EXTERNAL_VENDOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const INTERNAL_VENDOR_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeAll(async () => {
	pg = await bootstrapPglite();

	// One vendor genuinely outside the Letter Company, one that IS one of
	// ours (its own domain is in the INTERNAL set the same way
	// lettertrace.com is) — real rows in the real `vendors` table.
	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key, letterstory_org_id) values ($1, 'e2e-external', 'E2E External Vendor', 'e2e-vendor.example', 'test', 'lp_live_e2e_external', gen_random_uuid())",
		[EXTERNAL_VENDOR_ID],
	);
	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key, letterstory_org_id) values ($1, 'e2e-lettertrace', 'Lettertrace (e2e)', 'lettertrace.com', 'internal', 'lp_live_e2e_internal', gen_random_uuid())",
		[INTERNAL_VENDOR_ID],
	);
});

afterAll(async () => {
	await pg.close();
});

/** createCustomer/updateCustomer, unmodified, against the real schema — see pglite-supabase.ts. */
function pgliteSupabase() {
	return sharedPgliteSupabase(pg);
}

beforeEach(() => vi.clearAllMocks());

async function customerRow(vendorId: string, slug: string): Promise<{ domain: string } | null> {
	const { rows } = await pg.query<{ domain: string }>(
		"select * from vendor_customers where vendor_id = $1 and slug = $2",
		[vendorId, slug],
	);
	return rows[0] ?? null;
}

describe("createCustomer against a real Postgres schema", () => {
	it("lets an external vendor add The Letter Company as a real, consented customer", async () => {
		const { createCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		const result = await createCustomer(supabase as never, EXTERNAL_VENDOR_ID, {
			slug: "letterbrace-e2e",
			name: "Letterbrace",
			domain: "letterbrace.com",
			since: "2024-01",
			consent: "named",
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.domain).toBe("letterbrace.com");

		const row = await customerRow(EXTERNAL_VENDOR_ID, "letterbrace-e2e");
		expect(row).not.toBeNull();
		expect(row!.domain).toBe("letterbrace.com");
	});

	// The domain classifier itself (free_mail vs. internal vs. company) is
	// exhaustively unit-tested in identity/domains.test.ts; what's untested
	// anywhere is that THIS call site actually wires that check in for the
	// free_mail branch — every existing e2e case here only exercises
	// "internal". Same `classified.kind !== "company"` gate, but proven
	// against the real table so a future refactor that special-cases one
	// kind and not the other would be caught here.
	it("refuses a consumer mailbox domain, since a person's inbox is never a customer", async () => {
		const { createCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		const result = await createCustomer(supabase as never, EXTERNAL_VENDOR_ID, {
			slug: "gmail-e2e",
			name: "Some Person",
			domain: "gmail.com",
			since: "2024-01",
			consent: "named",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.body).toMatchObject({ kind: "free_mail" });

		const row = await customerRow(EXTERNAL_VENDOR_ID, "gmail-e2e");
		expect(row).toBeNull();
	});

	it("refuses a Letter Company vendor claiming another Letter Company domain as its customer", async () => {
		const { createCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		const result = await createCustomer(supabase as never, INTERNAL_VENDOR_ID, {
			slug: "letterbrace-e2e-2",
			name: "Letterbrace",
			domain: "letterbrace.com",
			since: "2024-01",
			consent: "named",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.body.kind).toBe("internal");

		const row = await customerRow(INTERNAL_VENDOR_ID, "letterbrace-e2e-2");
		expect(row).toBeNull();
	});
});

describe("updateCustomer against a real Postgres schema", () => {
	it("lets an external vendor move an existing customer onto a Letter Company domain", async () => {
		const { createCustomer, updateCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		await createCustomer(supabase as never, EXTERNAL_VENDOR_ID, {
			slug: "moves-to-letterbrace",
			name: "Placeholder",
			domain: "placeholder.example.com",
			since: "2024-01",
		});

		const result = await updateCustomer(supabase as never, EXTERNAL_VENDOR_ID, "moves-to-letterbrace", {
			domain: "letterbrace.com",
		});

		expect(result.ok).toBe(true);
		const row = await customerRow(EXTERNAL_VENDOR_ID, "moves-to-letterbrace");
		expect(row!.domain).toBe("letterbrace.com");
	});

	it("refuses moving a customer onto a consumer mailbox domain", async () => {
		const { createCustomer, updateCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		await createCustomer(supabase as never, EXTERNAL_VENDOR_ID, {
			slug: "stays-off-gmail",
			name: "Placeholder",
			domain: "placeholder3.example.com",
			since: "2024-01",
		});

		const result = await updateCustomer(supabase as never, EXTERNAL_VENDOR_ID, "stays-off-gmail", {
			domain: "gmail.com",
		});

		expect(result.ok).toBe(false);
		const row = await customerRow(EXTERNAL_VENDOR_ID, "stays-off-gmail");
		expect(row!.domain).toBe("placeholder3.example.com");
	});

	it("refuses a Letter Company vendor moving a customer onto another Letter Company domain", async () => {
		const { createCustomer, updateCustomer } = await import("./customers");
		const supabase = pgliteSupabase();

		await createCustomer(supabase as never, INTERNAL_VENDOR_ID, {
			slug: "stays-put",
			name: "Placeholder",
			domain: "placeholder2.example.com",
			since: "2024-01",
		});

		const result = await updateCustomer(supabase as never, INTERNAL_VENDOR_ID, "stays-put", {
			domain: "letterstory.com",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.body.kind).toBe("internal");

		const row = await customerRow(INTERNAL_VENDOR_ID, "stays-put");
		expect(row!.domain).toBe("placeholder2.example.com");
	});
});
