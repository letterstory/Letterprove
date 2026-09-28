import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";

/**
 * The Stripe corroboration journey (test plan section C1, ops artifact
 * 2026-09-24-letterprove-e2e-test-plan.md) against the REAL shared Letterprove
 * Supabase project and the REAL Stripe API in test mode — the live-network
 * gap `stripe-connect.e2e.test.ts` deliberately left open (its own header
 * comment: "Stripe/Resend network calls stay mocked at the boundary").
 *
 * Unlike the pglite sibling, `@/lib/db/client` is NOT mocked here — dbClient()
 * reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the real
 * environment, so every write in this file lands on the one shared
 * dev/preview/production Supabase project (there is no branch-per-PR for
 * this repo — see ops reference_letterprove-live-auth-e2e-recipe.md). Rows
 * are disposable (UUID-suffixed vendor) and removed in `afterAll` whether the
 * run passes or fails.
 *
 * `fetchSubscriptions`/`fetchPaidInvoices` (src/lib/stripe/fetch.ts) hit
 * https://api.stripe.com for real, using a real `rk_test_...` restricted key.
 * sync.ts's own design guarantees this is safe to run repeatedly: a
 * test-mode key NEVER writes payment evidence (it clears any standing rows
 * instead), so this test proves the real request/response contract — auth
 * header, pagination, invoice status_transitions shape — without ever
 * producing a claim that would need to be retracted.
 *
 * Skips itself (not failing CI) when the required credentials aren't
 * present, so this file is safe to leave in the default `npm test`
 * discovery — see vitest.config.ts's exclude, which keeps it OUT of the
 * secret-free `npm test` run and reachable only via `npm run test:live`.
 *
 * Required env:
 *   NEXT_PUBLIC_SUPABASE_URL       — same var name Letterprove's own runtime uses
 *   SUPABASE_SERVICE_ROLE_KEY      — same var name Letterprove's own runtime uses
 *   LETTERPROVE_LIVE_TEST_STRIPE_KEY — an rk_test_... restricted key (Subscriptions:read,
 *                                      Invoices:read) from a Stripe TEST-mode account.
 *                                      Deliberately its own var, never the app's runtime
 *                                      Stripe secret (there isn't one — vendors' keys live
 *                                      per-vendor, encrypted, in vendor_stripe_credentials).
 *
 * LETTERPROVE_STRIPE_ENCRYPTION_KEY is NOT required from the environment: this
 * file mints its own throwaway key, exactly like the pglite version, since
 * nothing outside this run ever needs to decrypt what it encrypts.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_TEST_KEY = process.env.LETTERPROVE_LIVE_TEST_STRIPE_KEY;

const HAVE_CREDS = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && STRIPE_TEST_KEY);

if (!HAVE_CREDS) {
	console.warn(
		"[stripe-connect.live.test] skipped — missing " +
			[
				!SUPABASE_URL && "NEXT_PUBLIC_SUPABASE_URL",
				!SUPABASE_SERVICE_ROLE_KEY && "SUPABASE_SERVICE_ROLE_KEY",
				!STRIPE_TEST_KEY && "LETTERPROVE_LIVE_TEST_STRIPE_KEY",
			]
				.filter(Boolean)
				.join(", "),
	);
}

const VENDOR_ID = randomUUID();
const VENDOR_SLUG = `stripe-live-e2e-${VENDOR_ID.slice(0, 8)}`;

let admin: SupabaseClient;

beforeAll(async () => {
	if (!HAVE_CREDS) return;
	admin = createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
		auth: { persistSession: false },
	});
	const { error } = await admin.from("vendors").insert({
		id: VENDOR_ID,
		slug: VENDOR_SLUG,
		name: "Stripe Live E2E (disposable)",
		domain: `${VENDOR_SLUG}.example`,
		category: "test",
		key: `lp_live_e2e_${VENDOR_ID}`,
		letterstory_org_id: randomUUID(),
	});
	if (error) throw new Error(`fixture vendor insert failed: ${error.message}`);
});

afterAll(async () => {
	if (!HAVE_CREDS) return;
	// Cascades vendor_stripe_credentials via its FK; evidence/unmatched tables
	// are keyed on vendor_id without a cascade, so clear them explicitly too.
	await admin.from("vendor_payment_evidence").delete().eq("vendor_id", VENDOR_ID);
	await admin.from("vendor_payment_unmatched").delete().eq("vendor_id", VENDOR_ID);
	await admin.from("vendor_stripe_credentials").delete().eq("vendor_id", VENDOR_ID);
	await admin.from("vendors").delete().eq("id", VENDOR_ID);
});

function serviceCallerFor(vendorId: string): OAuthPrincipal {
	return {
		tokenId: "letterstory-service",
		vendorId,
		userId: "letterstory-service",
		capabilities: ["vendor:read", "vendor:write"],
		orgId: "e2e-org",
	};
}

describe.skipIf(!HAVE_CREDS)("stripe connect/sync/disconnect, against the real Supabase project + real Stripe API", () => {
	it("connects a real rk_test_ key, syncs against the real Stripe API, and never stores test-mode evidence", async () => {
		process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
		try {
			const { dispatchTool } = await import("./registry");
			const caller = serviceCallerFor(VENDOR_ID);

			const connectOutcome = await dispatchTool("connect_stripe", { restricted_key: STRIPE_TEST_KEY }, caller);
			expect(connectOutcome.kind).toBe("result");
			expect((connectOutcome as { result: { ok: boolean } }).result.ok).toBe(true);
			expect(JSON.stringify(connectOutcome)).not.toContain(STRIPE_TEST_KEY as string);

			const { data: credRow } = await admin
				.from("vendor_stripe_credentials")
				.select("encrypted_key, livemode")
				.eq("vendor_id", VENDOR_ID)
				.maybeSingle();
			expect(credRow).toBeTruthy();
			expect(credRow?.encrypted_key).not.toContain(STRIPE_TEST_KEY as string);
			expect(credRow?.livemode).toBe(false);

			const readOutcome = await dispatchTool("get_stripe_connection", {}, caller);
			expect((readOutcome as { result: { body: { connected: boolean } } }).result.body.connected).toBe(true);

			// The real network call: fetchSubscriptions + fetchPaidInvoices hit
			// api.stripe.com for real, over the pinned Stripe-Version header this
			// key must actually authenticate against.
			const syncOutcome = await dispatchTool("sync_stripe_payments", {}, caller);
			expect(syncOutcome.kind).toBe("result");
			const syncResult = syncOutcome as {
				result: { ok: boolean; body: { test_mode?: boolean; matched?: number; scope_warning?: string } };
			};
			expect(syncResult.result.ok).toBe(true);
			// A test-mode key must never leave money-shaped evidence behind,
			// whatever it read — this is sync.ts's own load-bearing rule, proven
			// here against the real request/response shape rather than a mock.
			expect(syncResult.result.body.test_mode).toBe(true);

			const { data: evidenceRows } = await admin
				.from("vendor_payment_evidence")
				.select("id")
				.eq("vendor_id", VENDOR_ID);
			expect(evidenceRows ?? []).toHaveLength(0);

			const disconnectOutcome = await dispatchTool("disconnect_stripe", {}, caller);
			expect((disconnectOutcome as { result: { body: { disconnected: boolean } } }).result.body.disconnected).toBe(
				true,
			);

			const { data: afterDisconnect } = await admin
				.from("vendor_stripe_credentials")
				.select("vendor_id")
				.eq("vendor_id", VENDOR_ID)
				.maybeSingle();
			expect(afterDisconnect).toBeNull();
		} finally {
			delete process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY;
		}
	}, 30_000);

	it("refuses an unrestricted sk_ key against the real schema and writes nothing", async () => {
		process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
		try {
			const { dispatchTool } = await import("./registry");
			const outcome = await dispatchTool(
				"connect_stripe",
				{ restricted_key: "sk_test_unrestrictedDanger1" },
				serviceCallerFor(VENDOR_ID),
			);
			expect((outcome as { result: { ok: boolean } }).result.ok).toBe(false);

			const { data } = await admin.from("vendor_stripe_credentials").select("vendor_id").eq("vendor_id", VENDOR_ID);
			expect(data ?? []).toHaveLength(0);
		} finally {
			delete process.env.LETTERPROVE_STRIPE_ENCRYPTION_KEY;
		}
	});
});
