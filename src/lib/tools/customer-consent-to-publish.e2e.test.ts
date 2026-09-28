import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthPrincipal } from "@/lib/oauth/scopes";
import { bootstrapPglite, pgliteSupabase } from "@/lib/test-support/pglite-supabase";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn() }));
vi.mock("@/lib/email/consent", () => ({ sendConsentRequest: vi.fn() }));

/**
 * The customer lifecycle's one missing seam, per the 2026-09-28 e2e audit:
 * every other major hop (create_customer's domain gate, generateConsentLink,
 * the respond route, Stripe evidence, domain-verification+observe) already
 * has a real-Postgres e2e test in isolation, but nothing chains
 * "customer approves consent -> tier report reflects it -> vendor publishes ->
 * the public proof surface renders the named customer" as ONE flow against
 * real Postgres. This file is that chain.
 */

const VENDOR_ID = randomUUID();
const VENDOR_SLUG = "consent-chain-e2e";
const CUSTOMER_SLUG = "consent-chain-customer";
const CUSTOMER_DOMAIN = "consent-chain-customer.com";

let pg: PGlite;
let customerId: string;

beforeAll(async () => {
	pg = await bootstrapPglite();
	await pg.query(
		`insert into vendors (id, slug, name, domain, category, key, letterstory_org_id, domain_verified_at, proofs_published_at)
		 values ($1, $2, 'Consent Chain E2E', 'consent-chain-e2e.example', 'test', $3, gen_random_uuid(), now(), now())`,
		[VENDOR_ID, VENDOR_SLUG, `lp_live_${VENDOR_SLUG}`],
	);
});

afterAll(async () => {
	await pg.close();
});

beforeEach(async () => {
	vi.clearAllMocks();
	const { dbClient } = await import("@/lib/db/client");
	vi.mocked(dbClient).mockReturnValue(pgliteSupabase(pg) as never);

	await pg.query("delete from vendor_customers where vendor_id = $1", [VENDOR_ID]);
	customerId = randomUUID();
	await pg.query(
		`insert into vendor_customers (id, vendor_id, slug, name, domain, since, features, consent)
		 values ($1, $2, $3, 'Consent Chain Customer', $4, '2024-01', '{}', 'anonymous')`,
		[customerId, VENDOR_ID, CUSTOMER_SLUG, CUSTOMER_DOMAIN],
	);
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

/** Real chain: generateConsentLink -> mint token -> POST the real respond route -> approve. */
async function approveConsent() {
	const { dispatchTool } = await import("@/lib/tools/registry");
	const { sendConsentRequest } = await import("@/lib/email/consent");
	vi.mocked(sendConsentRequest).mockResolvedValue({ ok: true });

	await dispatchTool(
		"request_consent",
		{ slug: CUSTOMER_SLUG, contact_email: `ops@${CUSTOMER_DOMAIN}` },
		serviceCallerFor(VENDOR_ID),
		{ origin: "https://app.letterprove.com" },
	);
	const [sentArgs] = vi.mocked(sendConsentRequest).mock.calls[0];
	const token = new URL(sentArgs.url).searchParams.get("token")!;
	expect(token).toBeTruthy();

	const { POST } = await import("@/app/attest/[vendor]/[customer]/consent/respond/route");
	const form = new FormData();
	form.set("token", token);
	form.set("decision", "approve");
	const request = new NextRequest(`https://app.letterprove.com/attest/${VENDOR_SLUG}/${CUSTOMER_SLUG}/consent/respond`, {
		method: "POST",
		body: form,
	});
	const response = await POST(request, { params: Promise.resolve({ vendor: VENDOR_SLUG, customer: CUSTOMER_SLUG }) });
	expect(response.headers.get("location")).toContain("done=approve");
}

describe("consent -> publish, chained end to end against a real Postgres schema", () => {
	it("countersigning through the real respond route earns tier 4 on the public proof surface, with no observation at all", async () => {
		// Deliberately no hot_rollups row for this customer: proves earned()'s
		// countersignature short-circuit reaches the ACTUAL public page function,
		// not just the unit-level earned() call publish.schema.test.ts already covers.
		await approveConsent();

		const { rows } = await pg.query<{ countersigned_at: string | null; consent: string }>(
			"select countersigned_at, consent from vendor_customers where id = $1",
			[customerId],
		);
		expect(rows[0].consent).toBe("named");
		expect(rows[0].countersigned_at).not.toBeNull();

		const { publishedVendorProof } = await import("@/lib/attest/proofs");
		const proof = await publishedVendorProof(VENDOR_SLUG);
		expect(proof).not.toBeNull();

		const customerProof = proof!.customers.find((c) => c.current.customer === CUSTOMER_SLUG);
		expect(customerProof).toBeDefined();
		expect(customerProof!.current).toMatchObject({ tier: 4, verified: true, customer_domain: CUSTOMER_DOMAIN });
		expect(proof!.summary.attested_customers).toBeGreaterThanOrEqual(1);
	});

	it("declining consent leaves the customer un-countersigned and off the public proof surface", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const { sendConsentRequest } = await import("@/lib/email/consent");
		vi.mocked(sendConsentRequest).mockResolvedValue({ ok: true });

		await dispatchTool(
			"request_consent",
			{ slug: CUSTOMER_SLUG, contact_email: `ops@${CUSTOMER_DOMAIN}` },
			serviceCallerFor(VENDOR_ID),
			{ origin: "https://app.letterprove.com" },
		);
		const [sentArgs] = vi.mocked(sendConsentRequest).mock.calls[0];
		const token = new URL(sentArgs.url).searchParams.get("token")!;

		const { POST } = await import("@/app/attest/[vendor]/[customer]/consent/respond/route");
		const form = new FormData();
		form.set("token", token);
		form.set("decision", "decline");
		const request = new NextRequest(`https://app.letterprove.com/attest/${VENDOR_SLUG}/${CUSTOMER_SLUG}/consent/respond`, {
			method: "POST",
			body: form,
		});
		await POST(request, { params: Promise.resolve({ vendor: VENDOR_SLUG, customer: CUSTOMER_SLUG }) });

		const { rows } = await pg.query<{ countersigned_at: string | null; consent_declined_at: string | null }>(
			"select countersigned_at, consent_declined_at from vendor_customers where id = $1",
			[customerId],
		);
		expect(rows[0].countersigned_at).toBeNull();
		expect(rows[0].consent_declined_at).not.toBeNull();

		const { publishedVendorProof } = await import("@/lib/attest/proofs");
		const proof = await publishedVendorProof(VENDOR_SLUG);
		expect(proof!.customers.find((c) => c.current.customer === CUSTOMER_SLUG)).toBeUndefined();
	});

	it("the staff tier_report tool's status label agrees with its own earnedTier for a countersigned-but-unobserved customer", async () => {
		// Same scenario as the first test, read back through the OTHER consumer
		// of this fact: the cross-vendor staff report a human/Letterstory reads.
		await approveConsent();

		process.env.STAFF_USER_IDS = "staff-e2e-user";
		const { dispatchTool } = await import("@/lib/tools/registry");
		const outcome = await dispatchTool(
			"tier_report",
			{ vendor: VENDOR_SLUG },
			{ tokenId: "t1", vendorId: null, userId: "staff-e2e-user", capabilities: ["staff:read"] },
		);
		delete process.env.STAFF_USER_IDS;

		expect(outcome.kind).toBe("result");
		if (outcome.kind !== "result" || !outcome.result.ok) throw new Error("expected ok result");
		const body = outcome.result.body as {
			vendors: { rows: { domain: string; earnedTier: number | null; status: string }[] }[];
		};
		const row = body.vendors[0].rows.find((r) => r.domain === CUSTOMER_DOMAIN);
		expect(row).toBeDefined();
		expect(row!.earnedTier).toBe(4);
		// A status of "no-observation" here would flatly contradict earnedTier: 4
		// on the same row — the report telling its reader two different things
		// about the one customer it's describing.
		expect(row!.status).toBe("published");
	});
});
