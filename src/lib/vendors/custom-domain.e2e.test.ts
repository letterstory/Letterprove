import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";

/**
 * The lookups src/proxy.ts routes every custom-domain request through, against
 * the real `vendors` columns. proxy.test.ts mocks these out, so without this
 * file the rule that matters most — an unpublished vendor's domain answers
 * exactly like an unknown one — was never checked against a database.
 */

let pg: PGlite;

vi.mock("@/lib/db/client", () => ({ dbClient: () => pgliteSupabase(pg) }));

async function vendor(slug: string, domain: string, opts: { published?: boolean; customDomain?: string; verified?: boolean }) {
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, proofs_published_at, custom_domain, custom_domain_verified_at)
		 values (gen_random_uuid(), $1, $1, $2, 'test', $3, gen_random_uuid(), $4, $5, $6)`,
		[
			slug,
			domain,
			`lp_live_${slug}`,
			opts.published ? new Date().toISOString() : null,
			opts.customDomain ?? null,
			opts.verified ? new Date().toISOString() : null,
		],
	);
}

beforeAll(async () => {
	pg = await bootstrapPglite();
	await vendor("acme", "acme.example", { published: true, customDomain: "proof.acme.example", verified: true });
	await vendor("hidden", "hidden.example", { published: false, customDomain: "proof.hidden.example", verified: true });
	await vendor("pending", "pending.example", { published: true, customDomain: "proof.pending.example", verified: false });
});

afterAll(async () => {
	await pg.close();
});

describe("slugForCustomDomain", () => {
	it("routes a published vendor's domain to its slug, case-insensitively", async () => {
		const { slugForCustomDomain } = await import("./custom-domain");
		expect(await slugForCustomDomain("Proof.Acme.Example")).toBe("acme");
	});

	it("answers null for an unpublished vendor's domain, exactly as for an unknown one", async () => {
		const { slugForCustomDomain } = await import("./custom-domain");
		expect(await slugForCustomDomain("proof.hidden.example")).toBeNull();
		expect(await slugForCustomDomain("proof.nobody.example")).toBeNull();
	});
});

describe("liveCustomDomain", () => {
	it("names the domain only once it is verified", async () => {
		const { liveCustomDomain } = await import("./custom-domain");
		expect(await liveCustomDomain("acme")).toBe("proof.acme.example");
		expect(await liveCustomDomain("pending")).toBeNull();
		expect(await liveCustomDomain("nobody")).toBeNull();
	});
});
