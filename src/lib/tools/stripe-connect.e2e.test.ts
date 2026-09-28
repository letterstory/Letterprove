import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));

/**
 * connect_stripe / get_stripe_connection / disconnect_stripe against a real
 * Postgres schema, through the real dispatchTool — unlike registry.test.ts
 * (in-memory fake `.from()`) and credentials.test.ts (mocked DB), which
 * exercise the same code but can't see what Postgres actually does with the
 * `vendor_stripe_credentials` upsert, the encrypted-key round trip, or the
 * evidence-first-then-credential delete ordering `disconnect()` documents.
 *
 * sync_stripe_payments itself (the network+mapping path) is already covered
 * end to end against real Postgres by publish.schema.test.ts, which mocks
 * only fetch.ts. This file is the CONNECT half that had no real-Postgres
 * coverage at all — flagged by a 2026-09-28 e2e audit as the most
 * operationally risky untested seam in the vendor lifecycle, since it was
 * only "restored" (registry.ts's own comment) after having no caller at all
 * from #124 to whenever this tool set was rebuilt.
 */

const VENDOR_ID = randomUUID();
const VENDOR_SLUG = "stripe-connect-e2e";

let pg: PGlite;

beforeAll(async () => {
	pg = await bootstrapPglite();
	await pg.query(
		"insert into vendors (id, slug, name, domain, category, key, letterstory_org_id) values ($1, $2, 'Stripe Connect E2E', 'stripe-connect-e2e.example', 'test', $3, gen_random_uuid())",
		[VENDOR_ID, VENDOR_SLUG, `lp_live_${VENDOR_SLUG}`],
	);
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.clearAllMocks();
	process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase(pg) as never);
	await pg.query("delete from vendor_stripe_credentials where vendor_id = $1", [VENDOR_ID]);
	await pg.query("delete from vendor_payment_evidence where vendor_id = $1", [VENDOR_ID]);
	await pg.query("delete from vendor_payment_unmatched where vendor_id = $1", [VENDOR_ID]);
});

afterEach(() => {
	delete process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY;
});

// Mirrors authenticateToolRequest's real shape — see registry.e2e.test.ts.
function serviceCallerFor(vendorId: string): OAuthPrincipal {
	return {
		tokenId: "letterstory-service",
		vendorId,
		userId: "letterstory-service",
		capabilities: ["vendor:read", "vendor:write"],
		orgId: "e2e-org",
	};
}

describe("stripe connect/disconnect, against a real Postgres schema", () => {
	it("connects a restricted test key, reads it back through get_stripe_connection, never echoing key material", async () => {
		const { dispatchTool } = await import("./registry");

		const connectOutcome = await dispatchTool(
			"connect_stripe",
			{ restricted_key: "rk_test_e2eProbeKeyValue123" },
			serviceCallerFor(VENDOR_ID),
		);

		expect(connectOutcome).toMatchObject({
			kind: "result",
			result: { ok: true, body: { connected: true, livemode: false, last4: "e123" } },
		});
		// The whole point of connect_stripe: never echo the secret anywhere in the response.
		expect(JSON.stringify(connectOutcome)).not.toContain("rk_test_e2eProbeKeyValue123");

		// The row really landed, encrypted — not just an in-memory success.
		const { rows } = await pg.query<{ encrypted_key: string; key_last4: string; livemode: boolean }>(
			"select encrypted_key, key_last4, livemode from vendor_stripe_credentials where vendor_id = $1",
			[VENDOR_ID],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].encrypted_key).not.toContain("rk_test_e2eProbeKeyValue123");
		expect(rows[0].key_last4).toBe("e123");
		expect(rows[0].livemode).toBe(false);

		const readOutcome = await dispatchTool("get_stripe_connection", {}, serviceCallerFor(VENDOR_ID));
		expect(readOutcome).toMatchObject({
			kind: "result",
			result: { ok: true, body: { connected: true, livemode: false, last4: "e123" } },
		});
	});

	it("reconnecting (upsert) replaces the old credential rather than duplicating it", async () => {
		const { dispatchTool } = await import("./registry");

		await dispatchTool("connect_stripe", { restricted_key: "rk_test_firstKeyABCD1111" }, serviceCallerFor(VENDOR_ID));
		await dispatchTool("connect_stripe", { restricted_key: "rk_live_secondKeyEFGH2222" }, serviceCallerFor(VENDOR_ID));

		const { rows } = await pg.query("select key_last4, livemode from vendor_stripe_credentials where vendor_id = $1", [
			VENDOR_ID,
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ key_last4: "2222", livemode: true });
	});

	it("refuses an unrestricted sk_ key and writes nothing", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"connect_stripe",
			{ restricted_key: "sk_test_unrestrictedDanger1" },
			serviceCallerFor(VENDOR_ID),
		);

		expect(outcome).toMatchObject({ kind: "result", result: { ok: false, status: 400, body: { error: "unrestricted" } } });
		const { rows } = await pg.query("select 1 from vendor_stripe_credentials where vendor_id = $1", [VENDOR_ID]);
		expect(rows).toHaveLength(0);
	});

	it("refuses a publishable pk_ key and writes nothing", async () => {
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"connect_stripe",
			{ restricted_key: "pk_test_cannotReadAnything1" },
			serviceCallerFor(VENDOR_ID),
		);

		expect(outcome).toMatchObject({ kind: "result", result: { ok: false, status: 400, body: { error: "publishable" } } });
		const { rows } = await pg.query("select 1 from vendor_stripe_credentials where vendor_id = $1", [VENDOR_ID]);
		expect(rows).toHaveLength(0);
	});

	it("refuses to store a credential in the clear when no encryption key is configured", async () => {
		delete process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY;
		const { dispatchTool } = await import("./registry");

		const outcome = await dispatchTool(
			"connect_stripe",
			{ restricted_key: "rk_test_wouldBeStoredPlain1" },
			serviceCallerFor(VENDOR_ID),
		);

		expect(outcome).toMatchObject({
			kind: "result",
			result: { ok: false, status: 503, body: { error: "not_configured" } },
		});
		const { rows } = await pg.query("select 1 from vendor_stripe_credentials where vendor_id = $1", [VENDOR_ID]);
		expect(rows).toHaveLength(0);
	});

	it("get_stripe_connection reports not connected, honestly, for a vendor that never connected", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("get_stripe_connection", {}, serviceCallerFor(VENDOR_ID));
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { connected: false } } });
	});

	it("disconnect_stripe deletes evidence AND unmatched rows AND the credential itself", async () => {
		const { dispatchTool } = await import("./registry");
		await dispatchTool("connect_stripe", { restricted_key: "rk_live_toBeDisconnected1" }, serviceCallerFor(VENDOR_ID));

		// Seed evidence and an unmatched row directly — sync_stripe_payments'
		// own write path is publish.schema.test.ts's job; here we only need
		// rows to exist so disconnect's delete-ordering has something to prove.
		await pg.query(
			`insert into vendor_payment_evidence (vendor_id, domain, monthly_amount, currency, subscription_count, since, synced_at)
			 values ($1, 'evidence-co.example', 50000, 'usd', 1, now(), now())`,
			[VENDOR_ID],
		);
		await pg.query(
			`insert into vendor_payment_unmatched (vendor_id, subscription_id, reason, domain, synced_at)
			 values ($1, 'sub_x', 'not_a_company', 'gmail.com', now())`,
			[VENDOR_ID],
		);

		const outcome = await dispatchTool("disconnect_stripe", {}, serviceCallerFor(VENDOR_ID));
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { disconnected: true } } });

		const cred = await pg.query("select 1 from vendor_stripe_credentials where vendor_id = $1", [VENDOR_ID]);
		const evidence = await pg.query("select 1 from vendor_payment_evidence where vendor_id = $1", [VENDOR_ID]);
		const unmatched = await pg.query("select 1 from vendor_payment_unmatched where vendor_id = $1", [VENDOR_ID]);
		expect(cred.rows).toHaveLength(0);
		expect(evidence.rows).toHaveLength(0);
		expect(unmatched.rows).toHaveLength(0);
	});

	it("disconnect_stripe on a vendor with no credential is a harmless no-op, not an error", async () => {
		const { dispatchTool } = await import("./registry");
		const outcome = await dispatchTool("disconnect_stripe", {}, serviceCallerFor(VENDOR_ID));
		expect(outcome).toEqual({ kind: "result", result: { ok: true, body: { disconnected: true } } });
	});

	it("a caller with only vendor:read cannot connect_stripe (vendor:write required)", async () => {
		const { dispatchTool } = await import("./registry");
		const readOnly: OAuthPrincipal = { ...serviceCallerFor(VENDOR_ID), capabilities: ["vendor:read"] };

		const outcome = await dispatchTool("connect_stripe", { restricted_key: "rk_test_shouldNeverLand1" }, readOnly);

		expect(outcome).toEqual({ kind: "denied", capability: "vendor:write" });
		const { rows } = await pg.query("select 1 from vendor_stripe_credentials where vendor_id = $1", [VENDOR_ID]);
		expect(rows).toHaveLength(0);
	});
});
