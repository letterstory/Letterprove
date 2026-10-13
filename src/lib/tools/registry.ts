import type { OAuthPrincipal, Capability } from "@/lib/oauth/scopes";
import { z } from "zod";
import * as S from "@/lib/tools/schemas";
import { dbClient } from "@/lib/db/client";
import { findVendorByOrg } from "@/lib/fixtures/vendors";
import { provisionVendorForOrg } from "@/lib/vendors/provision";
import { domainRejectionReason, normalizeDomain } from "@/lib/vendors/domain";
import {
	checkDomainVerification,
	expectedRecord,
	verificationHosts,
	verificationMessage,
} from "@/lib/vendors/verification";
import { isStaffUser } from "@/lib/staff/allowlist";
import {
	listCustomers,
	createCustomer,
	updateCustomer,
	deleteCustomer,
	type CreateCustomerInput,
	type UpdateCustomerInput,
} from "@/lib/vendors/customers";
import { getVendorStatus } from "@/lib/vendors/status";
import { promoteDomain, type PromoteFailure } from "@/lib/staff/promote";
import { collectionHealth } from "@/lib/staff/health";
import { vendorRoster } from "@/lib/staff/vendors";
import { tierReport } from "@/lib/tiers/report";
import { vendorSlugs, vendorSnapshots, vendorProof } from "@/lib/attest/proofs";
import { TIER_LADDER } from "@/lib/attest/tiers";
import { installSnippet } from "@/lib/vendors/install";
import { badgeHtml, proofPageUrl } from "@/lib/vendors/badge";
import { MAX_HOSTS, checkHostVerification, classifyHost, forgetAcceptedHosts, hostStatus, type HostRow } from "@/lib/vendors/hosts";
import {
	attachDomain,
	checkCustomDomain,
	customDomainStatus,
	customDomainsConfigured,
	detachDomain,
	getDomainState,
	type CustomDomainRow,
} from "@/lib/vendors/custom-domain";
import { generateKey } from "@/lib/vendors/keys";
import { sendSupportMessage } from "@/lib/support/slack";
import {
	saveCredential,
	connectionFor,
	credentialFor,
	classifyKey,
	setProductScope,
	disconnect as disconnectStripeCredential,
	type KeyRejection,
	type StripeConnection,
} from "@/lib/stripe/credentials";
import { syncVendorPayments } from "@/lib/stripe/sync";
import { checkStripeAccount, overrideOf } from "@/lib/stripe/account";
import { fetchProducts } from "@/lib/stripe/fetch";
import { paymentEvidenceCount } from "@/lib/attest/payment-evidence";
import { agenticReadBillingReport, previousBillingMonth } from "@/lib/staff/billing";
import { vendorReadUsage } from "@/lib/billing/vendor-usage";

/**
 * The CLI-controllability seam: every operation a vendor can automate lives
 * here once, callable by name over a bearer token (src/app/api/v1/tools) and
 * eventually by MCP too, instead of each transport growing its own copy.
 *
 * Vendor *creation* (POST /api/vendor/onboarding) deliberately does not have
 * a tool entry — a bearer token is only mintable for a vendor that already
 * exists (see src/lib/oauth-auth.ts), so account creation is inherently a
 * one-time cookie-session step, not something a token can bootstrap itself.
 *
 * Handlers reach the database through dbClient() (service-role), not a
 * session client — a bearer caller has no cookie session to bind one to.
 * `principal.vendorId` is what scopes every query; it comes from a verified,
 * unexpired access token (see resolveAccessToken), not from request input.
 */

export type ToolResult =
	| { ok: true; body: unknown; status?: number }
	| { ok: false; status: number; body: Record<string, unknown> };

/**
 * Per-call context that isn't part of the principal or the caller's args —
 * currently just the request's own origin, needed by get_install_snippet
 * (see originFromHeaders) since a snippet pointing at the wrong host is a
 * silent, expensive failure (see src/lib/vendors/install.ts). Optional and
 * defaulted in dispatchTool so the ~20 existing 3-arg call sites in
 * registry.test.ts don't all need touching for a field only one handler uses.
 */
export type ToolContext = { origin: string | null };

export type ToolHandler = (args: unknown, principal: OAuthPrincipal, context: ToolContext) => Promise<ToolResult>;

export type ToolDef = {
	name: string;
	description: string;
	capability: Capability;
	/** What this tool accepts. Declared to be enforced, not to be published. */
	inputSchema: z.ZodType;
	/** The success payload. dispatchTool checks every non-production result against it. */
	outputSchema: z.ZodType;
	handler: ToolHandler;
};

/**
 * A tool that went through `defineTool`.
 *
 * The brand is a module-private symbol, so it cannot be forged from outside
 * this file: a plain object literal added to TOOLS is a compile error rather
 * than a tool that quietly ships undeclared. That matters because the failure
 * it prevents is invisible — a schema-less tool works perfectly, and only the
 * contract is missing, which nothing at runtime would notice.
 *
 * Same construction as Letterstory's BoundTool, so the two registries stay
 * legible to the same reader.
 */
declare const bound: unique symbol;
export type BoundTool = ToolDef & { readonly [bound]: true };

/** The only way to add a tool. "I'll declare it later" is not expressible. */
export function defineTool(def: ToolDef): BoundTool {
	return def as BoundTool;
}

function asRecord(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

// A null vendorId has two very different meanings, and collapsing them cost a
// demo: every vendor-scoped tool answered 500 for the ordinary state of an org
// that has never linked a vendor.
//
//   - orgId set (a Letterstory-service call): the org simply has no vendor yet.
//     That is the documented pre-vendor state find_vendor_by_org exists to
//     report — `{ linked: false }` — and Letterstory reads it as "offer to set
//     Proofs up". A 404 says the same thing to every OTHER tool, so a caller
//     that skips the find and goes straight for the data gets a clean, actionable
//     answer instead of an error that looks like Letterprove is broken.
//   - orgId null (a staff-only grant, see OAuthPrincipal): genuinely
//     unreachable — such a principal never carries a vendor:* capability, so
//     dispatchTool's gate means no vendor:* handler runs. Keep the 500: it is
//     the invariant check, and a bug in the gate should not read as "not linked".
function requireVendorId(principal: OAuthPrincipal): string | ToolResult {
	if (principal.vendorId) return principal.vendorId;
	if (principal.orgId) {
		return {
			ok: false,
			status: 404,
			body: {
				error: "vendor_not_linked",
				detail: "This organization has no Letterprove vendor yet. Create one with create_vendor.",
			},
		};
	}
	return { ok: false, status: 500, body: { error: "vendor_scope_without_vendor" } };
}

// The org this principal acts for, present ONLY for a Letterstory-service call
// (authenticateToolRequest). The two provisioning tools below run before a
// vendor exists, so they key on the org, not principal.vendorId — and a
// CLI/OAuth caller, which has no org context, is refused with 403 here.
function requireOrgId(principal: OAuthPrincipal): string | ToolResult {
	if (principal.orgId) return principal.orgId;
	return {
		ok: false,
		status: 403,
		body: { error: "org_context_required", detail: "This tool is only callable by Letterstory for a specific org." },
	};
}

// Mirrors src/app/api/vendor/support/route.ts's own limit — same reasoning
// as PROMOTE_STATUS below, a single shared constant isn't worth the coupling.
const MAX_SUPPORT_MESSAGE_LENGTH = 4000;

// Mirrors src/app/api/staff/customers/route.ts's STATUS map — kept in this
// file too rather than exported/shared, since a route and a tool handler
// diverging on one status code is a smaller risk than the coupling of a
// shared import for a five-entry constant.
const PROMOTE_STATUS: Record<PromoteFailure, number> = {
	vendor_unreadable: 404,
	not_attributable: 422,
	not_observed: 422,
	already_exists: 409,
	storage_unavailable: 503,
	write_failed: 500,
};

/**
 * Why a submitted Stripe key was refused, and what to answer.
 *
 * None of these details contain the submitted value: not the key, not a
 * prefix, not a masked form. A rejected key is still a live secret (the usual
 * way to get here is pasting the wrong one off the same Stripe page), and an
 * error body is the part of a tool response most likely to end up in a bug
 * report, a screenshot, or someone's terminal scrollback.
 */
const KEY_REFUSAL: Record<KeyRejection | "not_configured" | "storage_unavailable", { status: number; detail: string }> = {
	unrestricted: {
		status: 400,
		detail:
			"That is an unrestricted secret key (sk_). It can refund your customers, and publishing proof never needs that. Create a restricted key (rk_) with read access to Subscriptions, Invoices and Accounts instead. Nothing was stored.",
	},
	publishable: {
		status: 400,
		detail: "That is a publishable key (pk_). It cannot read subscriptions at all. Create a restricted key (rk_) with read access to Subscriptions, Invoices and Accounts instead. Nothing was stored.",
	},
	malformed: {
		status: 400,
		detail: "That is not a Stripe restricted key. It should begin with rk_live_ or rk_test_. Nothing was stored.",
	},
	not_configured: {
		status: 503,
		detail: "This deployment has no Stripe encryption key, so it refuses to store a credential it could only store in the clear. Nothing was written.",
	},
	storage_unavailable: { status: 503, detail: "Storage is unavailable. Nothing was written." },
};

/**
 * The connection as every Stripe tool reports it, so connect and read answer
 * with the same object and one renderer serves both. Built from
 * `StripeConnection`, which is itself the safe subset credentials.ts is
 * willing to hand out.
 */
function stripeConnectionBody(connection: StripeConnection, evidenceDomains: number | null) {
	return {
		connected: true as const,
		last4: connection.last4,
		livemode: connection.livemode,
		connected_at: connection.connectedAt,
		last_synced_at: connection.lastSyncedAt,
		last_sync_error: connection.lastSyncError,
		evidence_domains: evidenceDomains,
		product_scope: {
			mode: connection.productIds.length > 0 ? ("selected" as const) : ("all_products" as const),
			product_ids: connection.productIds,
		},
		account: connection.stripeAccountId
			? { id: connection.stripeAccountId, domains: connection.stripeAccountDomains, checked_at: connection.accountCheckedAt }
			: null,
	};
}

/** Why the account behind a key was refused, as a tool answers it. */
const ACCOUNT_REFUSAL_STATUS = {
	stripe_account_permission_missing: 400,
	stripe_account_domain_mismatch: 409,
	stripe_account_unreadable: 502,
} as const;

function productIdsArg(value: unknown): string[] | null {
	if (value === undefined) return null;
	const parsed = S.setStripeScopeInput.shape.product_ids.safeParse(value);
	return parsed.success ? [...new Set(parsed.data)].sort() : null;
}

export const TOOLS: BoundTool[] = [
	defineTool({
		// Pre-vendor: asked first by Letterstory's Proofs tab to decide whether
		// to show the surface or the setup flow. Keys on the org, not a vendor.
		name: "find_vendor_by_org",
		description: "Does a Letterstory org already have a Letterprove vendor? Returns { linked }.",
		capability: "vendor:read",
		inputSchema: S.findVendorByOrgInput,
		outputSchema: S.findVendorByOrgOutput,
		handler: async (_args, principal) => {
			const orgId = requireOrgId(principal);
			if (typeof orgId !== "string") return orgId;

			const vendor = await findVendorByOrg(orgId);
			if (!vendor) return { ok: true, body: { linked: false } };
			return { ok: true, body: { linked: true, slug: vendor.slug, domain: vendor.domain } };
		},
	}),
	defineTool({
		// Pre-vendor: the setup flow's write. Creates the vendor and links it to
		// the org 1:1. Authorized by the Letterstory service secret (the org
		// context), NOT by a vendor:* grant — no vendor exists to grant against.
		name: "create_vendor",
		description: "Create the Letterprove vendor for a Letterstory org, linked 1:1. Args: name, domain. Returns { linked }.",
		capability: "vendor:write",
		inputSchema: S.createVendorInput,
		outputSchema: S.createVendorOutput,
		handler: async (args, principal) => {
			const orgId = requireOrgId(principal);
			if (typeof orgId !== "string") return orgId;

			const record = asRecord(args);
			const name = typeof record.name === "string" ? record.name : "";
			const domain = typeof record.domain === "string" ? record.domain : "";
			if (!name.trim() || !domain.trim()) {
				return { ok: false, status: 400, body: { error: "name and domain are required" } };
			}

			const result = await provisionVendorForOrg(orgId, { name, domain });
			if (!result.ok) return { ok: false, status: result.status, body: { error: result.error } };
			return { ok: true, status: 201, body: { linked: true, slug: result.slug, domain: result.domain } };
		},
	}),
	defineTool({
		// The vendor attestation read back for the summary tab: tier + counts.
		// Returns
		// the slug so the caller builds the public /proofs, /attest URLs against
		// Letterprove's own origin (they must not point at the caller's host).
		name: "get_proof_summary",
		description: "The caller's vendor attestation, read back: tier, companies observed, paying companies, sessions, and the slug for public URLs. Works while private.",
		capability: "vendor:read",
		inputSchema: S.getProofSummaryInput,
		outputSchema: S.getProofSummaryOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db.from("vendors").select("slug").eq("id", vendorId).maybeSingle<{ slug: string }>();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };

			const proof = await vendorProof(vendor.slug);
			if (!proof) return { ok: false, status: 404, body: { error: "not_found" } };

			const { summary } = proof;
			return {
				ok: true,
				body: {
					slug: vendor.slug,
					tier: summary.tier,
					tier_name: TIER_LADDER[summary.tier].name,
					attested_customers: summary.paying_companies,
					paying_companies: summary.paying_companies,
					companies_observed: summary.companies_observed,
					sessions_30d: summary.sessions_30d,
					last_attested: summary.last_attested || null,
				},
			};
		},
	}),
	defineTool({
		// The vendor-scoped half of usage billing: the caller's own agentic reads,
		// month to date and last month, priced by the same function the fleet
		// report (`agentic_read_billing`) bills from. Without it the first a vendor
		// hears of usage pricing is the invoice.
		name: "get_read_usage",
		description:
			"The caller's own AI-agent proof reads: this month so far and last month, what each comes to, and the pricing bands.",
		capability: "vendor:read",
		inputSchema: S.getReadUsageInput,
		outputSchema: S.getReadUsageOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db.from("vendors").select("slug").eq("id", vendorId).maybeSingle<{ slug: string }>();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };

			const usage = await vendorReadUsage(vendor.slug);
			if (!usage) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			return { ok: true, body: usage };
		},
	}),
	defineTool({
		// The vendor-scoped twin of the staff-only `record_customer`: a vendor
		// (via Letterstory) turns one of its OWN observed domains into a customer.
		// Scoped to principal.vendorId, so it needs vendor:write, not the
		// cross-vendor staff:write `record_customer` carries — the Letterstory
		// service principal deliberately holds no staff capability.
		name: "record_observed",
		description:
			"Record one of the caller's own observed companies as a customer (anonymous, tier-1 ceiling). Args: domain.",
		capability: "vendor:write",
		inputSchema: S.recordObservedInput,
		outputSchema: S.recordObservedOutput,
		handler: async (args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const record = asRecord(args);
			const domain = typeof record.domain === "string" ? record.domain.trim() : "";
			if (!domain) return { ok: false, status: 400, body: { error: "domain is required" } };

			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			// promoteDomain keys on slug (it predates this path as a staff tool);
			// resolve the caller's own slug from their vendor id so they can never
			// name another vendor's.
			const { data: vendor } = await db.from("vendors").select("slug").eq("id", vendorId).maybeSingle<{ slug: string }>();
			if (!vendor) return { ok: false, status: 404, body: { error: "vendor_unreadable" } };

			const result = await promoteDomain(vendor.slug, domain);
			if (!result.ok) {
				return { ok: false, status: PROMOTE_STATUS[result.reason], body: { error: result.reason, detail: result.detail } };
			}
			return { ok: true, status: 201, body: { customer: result } };
		},
	}),
	defineTool({
		name: "list_customers",
		description: "List every customer recorded for the caller's vendor.",
		capability: "vendor:read",
		inputSchema: S.listCustomersInput,
		outputSchema: S.listCustomersOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await listCustomers(db, vendorId);
			if (!result.ok) return result;
			return { ok: true, body: { customers: result.data } };
		},
	}),
	defineTool({
		name: "create_customer",
		description: "Add a customer to the caller's private list. Never published: the attestation counts companies, it does not name them. Args: slug, name, domain, since.",
		capability: "vendor:write",
		inputSchema: S.createCustomerInput,
		outputSchema: S.createCustomerOutput,
		handler: async (args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await createCustomer(db, vendorId, asRecord(args) as CreateCustomerInput);
			if (!result.ok) return result;
			return { ok: true, status: 201, body: { customer: result.data } };
		},
	}),
	defineTool({
		name: "update_customer",
		description:
			"Update a customer on the caller's private list. Args: slug (required), plus any of name, domain, since, features.",
		capability: "vendor:write",
		inputSchema: S.updateCustomerInput,
		outputSchema: S.updateCustomerOutput,
		handler: async (args, principal) => {
			const record = asRecord(args);
			const slug = typeof record.slug === "string" ? record.slug : "";
			if (!slug) return { ok: false, status: 400, body: { error: "slug is required" } };

			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await updateCustomer(db, vendorId, slug, record as UpdateCustomerInput);
			if (!result.ok) return result;
			return { ok: true, body: { customer: result.data } };
		},
	}),
	defineTool({
		name: "delete_customer",
		description: "Delete one of the caller's customers. Args: slug (required).",
		capability: "vendor:write",
		inputSchema: S.deleteCustomerInput,
		outputSchema: S.deleteCustomerOutput,
		handler: async (args, principal) => {
			const record = asRecord(args);
			const slug = typeof record.slug === "string" ? record.slug : "";
			if (!slug) return { ok: false, status: 400, body: { error: "slug is required" } };

			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await deleteCustomer(db, vendorId, slug);
			if (!result.ok) return result;
			// Not 204: this seam always answers with a JSON body (see
			// LetterproveClient.request(), which calls res.json() on every
			// response), so an empty-body success is expressed as a flag instead.
			return { ok: true, body: { deleted: true } };
		},
	}),
	defineTool({
		name: "get_status",
		description:
			"Whether the caller's vendor has received any events in the last 24h and how many, whether the tracking script has ever successfully checked in at all, and whether the vendor's proofs are public yet.",
		capability: "vendor:read",
		inputSchema: S.getStatusInput,
		outputSchema: S.getStatusOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const result = await getVendorStatus(vendorId);
			if (!result.ok) return { ok: false, status: result.status, body: { error: result.error } };
			return {
				ok: true,
				body: {
					receiving: result.receiving,
					installed: result.installed,
					count: result.count,
					// The one read-back for the publication flag. Without it a
					// vendor has a write with no matching read and no way to
					// answer "is any of this public yet" short of curling their
					// own proof URL and interpreting a 404.
					published: result.publishedAt !== null,
					published_at: result.publishedAt,
				},
			};
		},
	}),
	defineTool({
		name: "list_observed",
		description:
			"The company domains behind your attestation's counts, for your eyes only: each observed domain and how it counts (observed, paying, excluded). Args: none. Read-only. Nothing here is published by name.",
		capability: "vendor:read",
		inputSchema: S.listObservedInput,
		outputSchema: S.listObservedOutput,
		/*
		 * The vendor-facing half of the observed view.
		 *
		 * `tier_report` reports the same rows but is staff:read and takes a
		 * vendor slug, so it will happily answer for anyone — sharing it here
		 * would put a single `if` between one vendor and every other vendor's
		 * customer list. This resolves the slug from the caller's own principal
		 * instead, so there is no argument to tamper with. Exactly the reasoning
		 * that made /api/vendor/observed a separate route from the staff one.
		 *
		 * Until now this surface had no API at all: the dashboard read it over a
		 * cookie session, which nothing outside a browser can present. A vendor
		 * on the CLI, or another Letter Company app embedding this, could see
		 * customers and proofs but not the one list that tells them what to do
		 * next.
		 */
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const { data: vendor } = await db.from("vendors").select("slug").eq("id", vendorId).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };

			const report = await tierReport(vendor.slug);
			// A failed telemetry read is NOT "no companies observed". Reporting
			// zero would tell a vendor their install is broken when it may be
			// fine — the same distinction the aggregate makes when it refuses to
			// publish rather than publish a zero.
			if (!report) return { ok: false, status: 503, body: { error: "telemetry_unavailable" } };

			return {
				ok: true,
				body: {
					observed: report.observed,
					attributable: report.attributable,
					awaiting: report.unpublishedEvidence,
					published: report.published,
					paying: report.paying,
					domains: report.rows.map((row) => ({
						domain: row.domain,
						kind: row.kind,
						sessions: row.sessions,
						signups: row.signups,
						logins: row.logins,
						customer: row.customer,
						status: row.status,
						detail: row.detail,
					})),
				},
			};
		},
	}),
	defineTool({
		name: "record_customer",
		description:
			"Turn a domain observed for a vendor into a customer record (anonymous, tier-1 ceiling). Args: vendor (slug), domain.",
		capability: "staff:write",
		inputSchema: S.recordCustomerInput,
		outputSchema: S.recordCustomerOutput,
		// Staff tools act across vendors by slug, not principal.vendorId — a
		// staff-only grant has no vendor of its own (see requireVendorId).
		handler: async (args) => {
			const record = asRecord(args);
			const vendor = typeof record.vendor === "string" ? record.vendor.trim() : "";
			const domain = typeof record.domain === "string" ? record.domain.trim() : "";
			if (!vendor || !domain) return { ok: false, status: 400, body: { error: "vendor and domain are required" } };

			const result = await promoteDomain(vendor, domain);
			if (!result.ok) {
				return { ok: false, status: PROMOTE_STATUS[result.reason], body: { error: result.reason, detail: result.detail } };
			}
			return { ok: true, status: 201, body: { customer: result } };
		},
	}),
	defineTool({
		name: "collection_health",
		description:
			"Fleet-wide collection health: per vendor, whether the tracking script is reporting, silent, installed-but-quiet, or was never installed, with event counts over 24h/7d/30d. Args: none.",
		capability: "staff:read",
		inputSchema: S.collectionHealthInput,
		outputSchema: S.collectionHealthOutput,
		/*
		 * The staff index used to read collectionHealth() straight off
		 * Letterprove's database, which was fine while the page lived in this
		 * app. It doesn't anymore (#124), and Letterstory cannot reach this
		 * database — so the view had no way to exist until this tool did.
		 *
		 * A null return means the telemetry read FAILED, which is not the same
		 * as a healthy fleet with nothing to report. Surfaced as 503 rather
		 * than an empty list, for the reason list_observed already gives: a
		 * zero that actually means "we couldn't look" sends staff chasing an
		 * outage that isn't there, or worse, ignoring one that is.
		 */
		handler: async () => {
			const health = await collectionHealth();
			if (!health) return { ok: false, status: 503, body: { error: "telemetry_unavailable" } };
			return { ok: true, body: { vendors: health } };
		},
	}),
	defineTool({
		name: "vendor_roster",
		description: "Every vendor, their customer counts, and what their aggregate attestation currently claims. Args: none.",
		capability: "staff:read",
		inputSchema: S.vendorRosterInput,
		outputSchema: S.vendorRosterOutput,
		/*
		 * Same story as collection_health: the /staff/vendors page read
		 * vendorRoster() directly and lost its home in #124.
		 *
		 * staff:read rather than vendor:read because this is cross-vendor: a
		 * vendor must never be able to enumerate every other vendor on the
		 * platform, whatever fields the response carries. It used to also
		 * return member email addresses (via vendor_members, dropped by
		 * 20260828130000) — membership lives in Letterstory's
		 * organization_users now, which this deployment cannot read.
		 */
		handler: async () => {
			const roster = await vendorRoster();
			if (!roster) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			return { ok: true, body: { vendors: roster } };
		},
	}),
	defineTool({
		name: "tier_report",
		description:
			"Per-domain tier status for a vendor: what's observed, what's a customer record, what's actually published. Args: vendor (slug, optional — every vendor if omitted).",
		capability: "staff:read",
		inputSchema: S.tierReportInput,
		outputSchema: S.tierReportOutput,
		handler: async (args) => {
			const record = asRecord(args);
			const requested = typeof record.vendor === "string" && record.vendor.trim() ? record.vendor.trim() : null;
			const slugs = requested ? [requested] : await vendorSlugs();

			const reports = await Promise.all(slugs.map((slug) => tierReport(slug)));
			const unreadable = slugs.filter((_, i) => reports[i] === null);
			const vendors = reports.filter((r) => r !== null);

			return {
				ok: true,
				body: {
					generated_at: new Date().toISOString(),
					vendors,
					...(unreadable.length > 0 && { unreadable }),
				},
			};
		},
	}),
	defineTool({
		name: "agentic_read_billing",
		description:
			"What each vendor owes for agentic reads this billing period, and its Letterstory org id to bill. Args: billing_month (YYYY-MM-01, optional — defaults to the previous calendar month).",
		capability: "billing:read",
		inputSchema: S.agenticReadBillingInput,
		outputSchema: S.agenticReadBillingOutput,
		/*
		 * Letterprove never holds a Stripe credential (Steve, 2026-09-26): this
		 * is the read half of usage billing, called by Letterstory's own
		 * unattended invoicing cron, which does the actual charging against the
		 * org's existing Stripe customer. `billing:read`, NOT `staff:read` — an
		 * unattended job is not a signed-in human, so this rides the plain
		 * Letterstory-service identity (oauth-auth.ts) rather than borrowing or
		 * widening staff's, which is reserved for a named acting person. Cross-
		 * vendor because the report is fleet-wide, not because the data is
		 * especially sensitive (it isn't: no PII, just counts and cents).
		 */
		handler: async (args) => {
			const record = asRecord(args);
			const billingMonth =
				typeof record.billing_month === "string" && record.billing_month.trim()
					? record.billing_month.trim()
					: undefined;

			const report = await agenticReadBillingReport({ billingMonth });
			if (!report) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			return {
				ok: true,
				body: {
					billing_month: billingMonth ?? previousBillingMonth(),
					vendors: report.map((row) => ({
						vendor: row.vendorSlug,
						org_id: row.letterstoryOrgId,
						read_count: row.charge.totalReads,
						tier2_reads: row.charge.tier2Reads,
						tier3_reads: row.charge.tier3Reads,
						amount_cents: row.charge.amountCents,
					})),
				},
			};
		},
	}),
	defineTool({
		name: "get_install_snippet",
		description: "The <script> tag to install on the caller's site, pointed at this server's own origin, and the \"Attested and proven by Letterprove\" footer badge (show it only when badge.live — before publishing its link is a 404). Args: none.",
		capability: "vendor:read",
		inputSchema: S.getInstallSnippetInput,
		outputSchema: S.getInstallSnippetOutput,
		handler: async (_args, principal, context) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			// The caller's request origin, not a stored/hardcoded one — see
			// src/lib/vendors/install.ts on why a wrong host here is silently
			// expensive. A tool call has no browser request, so this can be
			// legitimately unavailable (e.g. a non-HTTP transport).
			if (!context.origin) return { ok: false, status: 400, body: { error: "origin_unavailable" } };
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db.from("vendors").select("key, slug, proofs_published_at").eq("id", vendorId).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			// publishable_key is returned alongside the snippet rather than left
			// for the caller to recover. Letterstory was regex-ing it back out of
			// the data-key attribute of the very HTML we build here — parsing our
			// own markup to retrieve a value we had in hand. Not a secret: it
			// ships in the page (see install.ts), so returning it discloses
			// nothing the snippet did not already.
			return {
				ok: true,
				body: {
					snippet: installSnippet(context.origin, vendor.key),
					origin: context.origin,
					publishable_key: vendor.key,
					// The footer badge rides the same call: it is the other thing a
					// vendor pastes into their site. `live` is false until the vendor
					// publishes, because until then the page it links to is a 404.
					badge: {
						html: badgeHtml(context.origin, vendor.slug),
						href: proofPageUrl(context.origin, vendor.slug),
						live: Boolean(vendor.proofs_published_at),
					},
				},
			};
		},
	}),
	defineTool({
		name: "rotate_key",
		description:
			"Replace the caller's vendor publishable/collector key with a freshly generated one. The old key stops working immediately — every existing install must be updated. Args: none.",
		capability: "vendor:write",
		inputSchema: S.rotateKeyInput,
		outputSchema: S.rotateKeyOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db.from("vendors").select("slug").eq("id", vendorId).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			const key = generateKey(vendor.slug);
			const { error } = await db.from("vendors").update({ key }).eq("id", vendorId);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			return { ok: true, body: { key } };
		},
	}),
	defineTool({
		name: "verify_domain",
		description:
			"Check DNS for this vendor's domain-verification TXT record and record the result. No args.",
		capability: "vendor:write",
		inputSchema: S.verifyDomainInput,
		outputSchema: S.verifyDomainOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const { data: vendor } = await db
				.from("vendors")
				.select("domain, domain_verification_token, domain_verified_at")
				.eq("id", vendorId)
				.maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			if (!vendor.domain_verification_token) {
				return { ok: false, status: 409, body: { error: "no_verification_token" } };
			}

			const outcome = await checkDomainVerification(vendor.domain, vendor.domain_verification_token);
			const message = verificationMessage(outcome, vendor.domain);

			if (!outcome.verified) {
				// A failed lookup must not un-verify an already-proven vendor;
				// DNS is allowed to be briefly unreachable.
				return {
					ok: true,
					body: {
						// The domain this answer is ABOUT. Absent until now, which
						// made the response un-renderable on its own: Letterstory's
						// domain card had nothing to name, and showed a verified
						// state with an empty subject next to it.
						domain: vendor.domain,
						verified: Boolean(vendor.domain_verified_at),
						checked: false,
						message,
						record: expectedRecord(vendor.domain_verification_token),
						hosts: verificationHosts(vendor.domain),
					},
				};
			}

			const verifiedAt = new Date().toISOString();
			// A fresh proof also ends any run of misses the daily re-check was
			// counting (src/lib/vendors/dns-recheck.ts).
			const { error } = await db
				.from("vendors")
				.update({ domain_verified_at: verifiedAt, domain_dns_failures: 0, domain_dns_failing_since: null })
				.eq("id", vendorId);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			return {
				ok: true,
				body: { domain: vendor.domain, verified: true, checked: true, message, verified_at: verifiedAt },
			};
		},
	}),
	defineTool({
		/*
		 * Publication is the vendor's own decision, so this is `vendor:write`
		 * and takes no vendor argument — the row is resolved from the caller's
		 * principal, the same way `verify_domain` and `rotate_key` resolve
		 * theirs.
		 *
		 * WHY NOT STAFF-ONLY, given self-serve does not exist yet. Staff
		 * already reach this: `authenticateToolRequest` builds the principal
		 * from the org the call is acting for, so a staff member working inside
		 * a vendor's Letterstory workspace gets `vendor:write` for that vendor
		 * today. A staff-scoped duplicate taking a slug would add a second
		 * write path to the same field and reach nothing the first one cannot
		 * — and a second path to a gate is how gates rot. When self-serve
		 * lands, this tool is already it.
		 *
		 * REFUSES AN UNVERIFIED DOMAIN. `POST /v1/observe` records nothing for
		 * a vendor whose domain is unproven, so publishing one publishes a
		 * signed document that can only ever say zero — a confident public
		 * claim with no evidence under it, which is the thing this product
		 * exists to stop being normal.
		 */
		name: "publish_proofs",
		description:
			"Make the caller's vendor proofs public — /proofs/{slug}, /attest/{slug} and both chain routes start resolving. Collection, rollups and signing were already running; this only opens the doors. Args: none.",
		capability: "vendor:write",
		inputSchema: S.publishProofsInput,
		outputSchema: S.publishProofsOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const { data: vendor } = await db
				.from("vendors")
				.select("slug, domain_verified_at, proofs_published_at")
				.eq("id", vendorId)
				.maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			if (!vendor.domain_verified_at) {
				return { ok: false, status: 409, body: { error: "domain_not_verified" } };
			}

			// Idempotent: publishing an already-public vendor returns the date
			// it actually went public rather than restating it as today. This
			// is a fact about the past and a retry must not rewrite it.
			if (vendor.proofs_published_at) {
				return {
					ok: true,
					body: { published: true, published_at: vendor.proofs_published_at, slug: vendor.slug },
				};
			}

			const publishedAt = new Date().toISOString();
			const { error } = await db.from("vendors").update({ proofs_published_at: publishedAt }).eq("id", vendorId);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			return { ok: true, body: { published: true, published_at: publishedAt, slug: vendor.slug } };
		},
	}),
	defineTool({
		/*
		 * The way back. Publication is reversible because a vendor must be able
		 * to stop — but it is not a retraction, and the response says so rather
		 * than letting the name imply otherwise. A signed document fetched
		 * while the vendor was public stays valid forever: that is the whole
		 * point of signing it.
		 */
		name: "unpublish_proofs",
		description:
			"Take the caller's vendor proofs private again. Every public route 404s; collection, rollups and signing continue. Does not invalidate anything already fetched. Args: none.",
		capability: "vendor:write",
		inputSchema: S.unpublishProofsInput,
		outputSchema: S.unpublishProofsOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const { error } = await db.from("vendors").update({ proofs_published_at: null }).eq("id", vendorId);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			return {
				ok: true,
				body: {
					published: false,
					note: "Public routes now 404. Documents fetched while this vendor was public remain signed and verifiable — unpublishing stops serving, it cannot un-fetch.",
				},
			};
		},
	}),
	defineTool({
		name: "update_vendor",
		description: "Update the caller's own vendor account. Args: any of name, domain, category.",
		capability: "vendor:write",
		inputSchema: S.updateVendorInput,
		outputSchema: S.updateVendorOutput,
		handler: async (args, principal) => {
			const record = asRecord(args);
			const update: Record<string, unknown> = {};
			if (typeof record.name === "string" && record.name.trim()) update.name = record.name.trim();
			if (typeof record.domain === "string" && record.domain.trim()) {
				// Same normalisation the signup form applies. Without it the CLI
				// is a back door to exactly the unmatchable value the form now
				// rejects — and this path uses the service-role client, so no
				// RLS policy stands behind it either.
				const normalized = normalizeDomain(record.domain);
				if (!normalized) {
					return { ok: false, status: 400, body: { error: domainRejectionReason(record.domain) } };
				}
				update.domain = normalized;
			}
			if (typeof record.category === "string" && record.category.trim()) update.category = record.category.trim();
			if (Object.keys(update).length === 0) {
				return { ok: false, status: 400, body: { error: "at least one of name, domain, category is required" } };
			}

			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db
				.from("vendors")
				.select("slug, name, domain, category, domain_verified_at")
				.eq("id", vendorId)
				.maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			// Changing the domain invalidates the proof of control that was
			// granted for the old one. Without this a vendor could verify a
			// domain they own, then repoint the row at one they do not and
			// keep the verified flag — which is the entire attack the DNS
			// check exists to stop.
			if (typeof update.domain === "string" && update.domain !== vendor.domain) {
				update.domain_verified_at = null;
			}
			// And any run of re-check misses counted against the old domain.
			const resetRecheck =
				update.domain_verified_at === null ? { domain_dns_failures: 0, domain_dns_failing_since: null } : {};

			const { error } = await db.from("vendors").update({ ...update, ...resetRecheck }).eq("id", vendorId);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			// Extra hosts were proven relative to the old domain; none of them
			// carries over to a new one.
			if (update.domain_verified_at === null) {
				await db.from("vendor_hosts").delete().eq("vendor_id", vendorId);
				forgetAcceptedHosts(vendorId);
			}
			return { ok: true, body: { vendor: { ...vendor, ...update } } };
		},
	}),
	defineTool({
		name: "list_snapshots",
		description:
			"History of the retired per-customer chains (frozen up to 2026-10-13; nothing new is added — Letterprove now publishes one vendor attestation). Args: customer (slug, optional).",
		capability: "vendor:read",
		inputSchema: S.listSnapshotsInput,
		outputSchema: S.listSnapshotsOutput,
		handler: async (args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db.from("vendors").select("slug").eq("id", vendorId).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };

			const record = asRecord(args);
			const customer = typeof record.customer === "string" && record.customer.trim() ? record.customer.trim() : undefined;
			const snapshots = await vendorSnapshots(vendor.slug, customer);
			if (snapshots === null) return { ok: false, status: 404, body: { error: "not_found" } };
			return { ok: true, body: { snapshots } };
		},
	}),
	defineTool({
		name: "submit_support_request",
		description: "Send a support message to the team, attributed to the caller's vendor and account. Args: message.",
		capability: "vendor:write",
		inputSchema: S.submitSupportRequestInput,
		outputSchema: S.submitSupportRequestOutput,
		handler: async (args, principal) => {
			const record = asRecord(args);
			const message = typeof record.message === "string" ? record.message.trim() : "";
			if (!message) return { ok: false, status: 400, body: { error: "message is required" } };
			if (message.length > MAX_SUPPORT_MESSAGE_LENGTH) {
				return { ok: false, status: 400, body: { error: `message must be under ${MAX_SUPPORT_MESSAGE_LENGTH} characters` } };
			}

			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db.from("vendors").select("name, slug").eq("id", vendorId).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };

			// A bearer token has no cookie session to read an email off of (see
			// this file's own header comment) — resolve it from the user id via
			// the service-role client's admin API instead, same as the route
			// resolves it from the signed-in session's user object.
			const { data: userData } = await db.auth.admin.getUserById(principal.userId);

			const result = await sendSupportMessage({
				vendorName: vendor.name,
				vendorSlug: vendor.slug,
				userEmail: userData?.user?.email ?? "unknown",
				message,
			});
			if (!result.ok) return { ok: false, status: 502, body: { error: result.error ?? "Failed to send your message" } };
			return { ok: true, body: { ok: true } };
		},
	}),
	/*
	 * ------------------------------------------------------------------ stripe
	 *
	 * Tier 3 is the first claim that escapes vendor origination: a vendor can
	 * cancel a subscription, but they cannot invent one without defrauding
	 * themselves. All of the machinery for it has existed since #119 in
	 * src/lib/stripe, and none of it had a caller, because the dashboard that
	 * used to drive it went away with the auth unification in #124. So every
	 * customer was capped below the tier that matters most, for want of a way
	 * to connect a key. These four are that way back.
	 *
	 * connect_stripe is the ONLY tool in this registry that takes a secret as
	 * an argument, and the rules that follow from that are worth stating once,
	 * here, where the next person adding one will read them:
	 *
	 *   - It travels in a POST body, never a query string, because query
	 *     strings land in access logs on every hop between the vendor and here.
	 *     The route is POST-only, so this holds structurally.
	 *   - Nothing echoes it. Not the success body (see connectStripeOutput),
	 *     not the error bodies (see KEY_REFUSAL), not a log line. dispatchTool
	 *     validates non-production successes by throwing an error containing
	 *     the offending BODY, which is exactly why the key must never be in one.
	 *   - classifyKey refuses an unrestricted sk_ and a publishable pk_ before
	 *     anything is written, and saveCredential refuses everything when no
	 *     encryption key is configured rather than storing a live credential in
	 *     the clear.
	 */
	defineTool({
		name: "connect_stripe",
		description:
			"Store a Stripe RESTRICTED key (rk_) for the caller's vendor, so payments can corroborate customers at tier 3. Args: restricted_key, which needs read access to Subscriptions, Invoices and Accounts; product_ids (optional) — the Stripe products that are this product, when the account bills several. The Stripe account must be the vendor's own: one of the domains it publishes (business website, support email) has to share the vendor's verified domain, or the key is refused. An unrestricted sk_ or publishable pk_ key is refused. The key is never returned.",
		capability: "vendor:write",
		inputSchema: S.connectStripeInput,
		outputSchema: S.connectStripeOutput,
		handler: async (args, principal) => {
			// From the caller's token, like every other vendor-scoped tool. A
			// vendor argument here would let anyone holding any vendor grant
			// point a Stripe credential at somebody else's account.
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const record = asRecord(args);
			const submitted = record.restricted_key;
			// Deliberately reports only that the field is missing. Saying what
			// arrived would mean quoting a secret back.
			if (typeof submitted !== "string" || !submitted.trim()) {
				return { ok: false, status: 400, body: { error: "restricted_key is required" } };
			}

			const productIds = record.product_ids === undefined ? undefined : productIdsArg(record.product_ids);
			if (productIds === null) {
				return { ok: false, status: 400, body: { error: "invalid_product_ids", detail: "product_ids must be Stripe product ids (prod_…)." } };
			}

			// Refuse the obvious key mistakes before any network call, so an sk_
			// key is never sent anywhere, even to Stripe.
			const classified = classifyKey(submitted);
			if (!classified.ok) {
				const refusal = KEY_REFUSAL[classified.reason];
				return { ok: false, status: refusal.status, body: { error: classified.reason, detail: refusal.detail } };
			}

			// The ledger has to be this vendor's before it is stored at all: a key
			// for someone else's account is refused, not kept and quietly ignored.
			const account = await checkStripeAccount(classified.key, vendorId);
			if (!account.ok) {
				return { ok: false, status: ACCOUNT_REFUSAL_STATUS[account.error], body: { error: account.error, detail: account.detail } };
			}

			const saved = await saveCredential(vendorId, submitted, { productIds, account: account.account });
			if (!saved.ok) {
				const refusal = KEY_REFUSAL[saved.reason];
				return { ok: false, status: refusal.status, body: { error: saved.reason, detail: refusal.detail } };
			}

			// Read back rather than assemble from what we just sent. It proves
			// the row landed, and it means this tool and get_stripe_connection
			// answer with the same object built from the same source.
			const connection = await connectionFor(vendorId);
			if (!connection) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			return { ok: true, body: stripeConnectionBody(connection, await paymentEvidenceCount(vendorId)) };
		},
	}),
	defineTool({
		name: "get_stripe_connection",
		description:
			"The state of the caller's vendor's Stripe connection: which key suffix, live or test, when it last synced, what Stripe last said, and how many customer domains currently carry payment evidence. No args. Never returns key material.",
		capability: "vendor:read",
		inputSchema: S.getStripeConnectionInput,
		outputSchema: S.getStripeConnectionOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const connection = await connectionFor(vendorId);
			// Not connected is an ordinary answer, the state of every vendor
			// that has never done this, so it is a body rather than a 404.
			if (!connection) return { ok: true, body: { connected: false } };
			return { ok: true, body: stripeConnectionBody(connection, await paymentEvidenceCount(vendorId)) };
		},
	}),
	defineTool({
		name: "sync_stripe_payments",
		description:
			"Read the caller's vendor's Stripe subscriptions and settled invoices, join them to observed usage, and replace their payment evidence. No args. A subscription with no invoice that actually settled is not evidence and is reported as unmatched. A test-mode key reports real counts and stores nothing.",
		capability: "vendor:write",
		inputSchema: S.syncStripePaymentsInput,
		outputSchema: S.syncStripePaymentsOutput,
		/*
		 * The one thing that puts evidence in front of the tier gate. `earned()`
		 * in attest/body.ts already reads vendor_payment_evidence on every
		 * publish; syncVendorPayments already fills it. Nothing called it.
		 *
		 * Writes, not reads, hence vendor:write: it replaces the vendor's
		 * evidence wholesale, and a cancelled subscription DISAPPEARING is as
		 * much of the point as a new one appearing.
		 */
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			// Checked here rather than pattern-matching the sync's error string
			// afterwards: "you have not connected Stripe" is a precondition the
			// caller handles differently from "Stripe would not answer".
			const connection = await connectionFor(vendorId);
			if (!connection) {
				return {
					ok: false,
					status: 409,
					body: { error: "stripe_not_connected", detail: "Connect a Stripe restricted key first with connect_stripe." },
				};
			}

			const { data: vendor } = await db.from("vendors").select("slug").eq("id", vendorId).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };

			const result = await syncVendorPayments(vendorId, vendor.slug);
			if (!result.ok) {
				// Stripe's own message, relayed. It names an expired key or a
				// missing permission directly, where anything invented here would
				// say "sync failed". Stripe redacts the middle of a key in its own
				// error text, which is why relaying it is safe.
				return { ok: false, status: 502, body: { error: "stripe_sync_failed", detail: result.error } };
			}
			return {
				ok: true,
				body: {
					matched: result.matched,
					unmatched: result.unmatched,
					test_mode: result.testMode,
					truncated: result.truncated,
					// Only ever set on a test key that cannot read Invoices. It
					// deliberately does not fail the sync (nothing is at risk when
					// nothing is stored), which means this string is the only way
					// the vendor ever learns about it.
					...(result.scopeWarning ? { scope_warning: result.scopeWarning } : {}),
				},
			};
		},
	}),
	defineTool({
		name: "list_stripe_products",
		description:
			"The products in the caller's vendor's connected Stripe account, with whether each has a recurring price, and the current product scope. No args. Use it to choose product_ids for set_stripe_scope when the account bills more than one product.",
		capability: "vendor:read",
		inputSchema: S.listStripeProductsInput,
		outputSchema: S.listStripeProductsOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const credential = await credentialFor(vendorId);
			if (!credential) {
				return { ok: false, status: 409, body: { error: "stripe_not_connected", detail: "Connect a Stripe restricted key first with connect_stripe." } };
			}
			const listed = await fetchProducts(credential.key);
			if (!listed.ok) return { ok: false, status: 502, body: { error: "stripe_read_failed", detail: listed.error } };
			return {
				ok: true,
				body: {
					products: listed.products,
					names_available: listed.namesAvailable,
					product_scope: {
						mode: credential.productIds.length > 0 ? ("selected" as const) : ("all_products" as const),
						product_ids: credential.productIds,
					},
				},
			};
		},
	}),
	defineTool({
		name: "set_stripe_scope",
		description:
			"Choose which Stripe products are this product, so payments for the account's other products stop corroborating customers. Args: product_ids (Stripe product ids; an empty list means every product counts). Takes effect at the next sync — run sync_stripe_payments to apply it now.",
		capability: "vendor:write",
		inputSchema: S.setStripeScopeInput,
		outputSchema: S.setStripeScopeOutput,
		handler: async (args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const productIds = productIdsArg(asRecord(args).product_ids ?? null);
			if (productIds === null) {
				return { ok: false, status: 400, body: { error: "invalid_product_ids", detail: "product_ids must be a list of Stripe product ids (prod_…)." } };
			}
			if (!(await connectionFor(vendorId))) {
				return { ok: false, status: 409, body: { error: "stripe_not_connected", detail: "Connect a Stripe restricted key first with connect_stripe." } };
			}
			if (!(await setProductScope(vendorId, productIds))) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const connection = await connectionFor(vendorId);
			if (!connection) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			return { ok: true, body: stripeConnectionBody(connection, await paymentEvidenceCount(vendorId)) };
		},
	}),
	defineTool({
		name: "set_stripe_account_override",
		description:
			"Staff only. Approve a vendor's Stripe account whose published domains don't match the vendor's verified domain (e.g. a parent company billing for a subsidiary), or clear that approval. Args: vendor (slug), reason (required when setting), stripe_account_id (optional — defaults to the account behind the vendor's connected key), clear (optional). The approval covers that one account only.",
		capability: "staff:write",
		inputSchema: S.setStripeAccountOverrideInput,
		outputSchema: S.setStripeAccountOverrideOutput,
		// Staff tools act across vendors by slug, not principal.vendorId.
		handler: async (args, principal) => {
			const record = asRecord(args);
			const slug = typeof record.vendor === "string" ? record.vendor.trim() : "";
			if (!slug) return { ok: false, status: 400, body: { error: "vendor is required" } };
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const { data: vendor } = await db.from("vendors").select("id, slug").eq("slug", slug).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };

			if (record.clear === true) {
				const { error } = await db
					.from("vendors")
					.update({
						stripe_account_override_account_id: null,
						stripe_account_override_at: null,
						stripe_account_override_by: null,
						stripe_account_override_reason: null,
					})
					.eq("id", vendor.id);
				if (error) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
				return { ok: true, body: { vendor: vendor.slug, override: null } };
			}

			const reason = typeof record.reason === "string" ? record.reason.trim() : "";
			if (reason.length < 10) {
				return { ok: false, status: 400, body: { error: "reason_required", detail: "Say why this account may corroborate a vendor on a different domain (at least 10 characters)." } };
			}
			let accountId = typeof record.stripe_account_id === "string" ? record.stripe_account_id.trim() : "";
			if (!accountId) {
				const connection = await connectionFor(vendor.id);
				accountId = connection?.stripeAccountId ?? "";
			}
			if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) {
				return {
					ok: false,
					status: 409,
					body: { error: "account_unknown", detail: "No Stripe account has been read for this vendor yet. Pass stripe_account_id, or have the vendor connect a key with Accounts read first." },
				};
			}

			const at = new Date().toISOString();
			const { error } = await db
				.from("vendors")
				.update({
					stripe_account_override_account_id: accountId,
					stripe_account_override_at: at,
					stripe_account_override_by: principal.userId ?? null,
					stripe_account_override_reason: reason,
				})
				.eq("id", vendor.id);
			if (error) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const saved = overrideOf({
				stripe_account_override_account_id: accountId,
				stripe_account_override_at: at,
				stripe_account_override_by: principal.userId ?? null,
				stripe_account_override_reason: reason,
			})!;
			return {
				ok: true,
				body: { vendor: vendor.slug, override: { stripe_account_id: saved.accountId, at: saved.at, by: saved.by, reason: saved.reason } },
			};
		},
	}),
	defineTool({
		name: "disconnect_stripe",
		description:
			"Remove the caller's vendor's Stripe key and every payment evidence row it produced. No args. Customers corroborated only by Stripe fall back to what observed usage alone earns.",
		capability: "vendor:write",
		inputSchema: S.disconnectStripeInput,
		outputSchema: S.disconnectStripeOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;

			const removed = await disconnectStripeCredential(vendorId);
			if (!removed) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			// Idempotent by construction: a delete that matched nothing is a
			// success, so a caller retrying after a network blip is not told the
			// disconnect failed.
			return { ok: true, body: { disconnected: true } };
		},
	}),
	defineTool({
		// Serve the proof page on the vendor's own domain (proof.acme.com). See
		// src/lib/vendors/custom-domain.ts for why it must sit under the vendor's
		// verified domain, and what stays on app.letterprove.com.
		name: "set_custom_domain",
		description:
			"Serve your public proof page on your own domain, e.g. proof.acme.com. Must be a subdomain of your verified domain. Returns the CNAME record to add. Args: domain.",
		capability: "vendor:write",
		inputSchema: S.setCustomDomainInput,
		outputSchema: S.setCustomDomainOutput,
		handler: async (args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			if (!customDomainsConfigured()) return { ok: false, status: 503, body: { error: "custom_domains_unavailable" } };
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const { data: vendor } = await db
				.from("vendors")
				.select("domain, domain_verified_at, custom_domain, proofs_published_at")
				.eq("id", vendorId)
				.maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			// The rule rests on DNS control of `domain`, so it has to be proven first.
			if (!vendor.domain_verified_at) {
				return { ok: false, status: 409, body: { error: "domain_not_verified", detail: "Verify your domain first; the proof domain sits under it." } };
			}

			const check = checkCustomDomain(String(asRecord(args).domain ?? ""), vendor.domain);
			if (!check.ok) return { ok: false, status: 400, body: { error: check.error, detail: check.detail } };
			const domain = check.domain;

			if (vendor.custom_domain !== domain) {
				const { data: taken } = await db.from("vendors").select("id").eq("custom_domain", domain).neq("id", vendorId).maybeSingle();
				if (taken) return { ok: false, status: 409, body: { error: "domain_taken", detail: `${domain} is already another vendor's proof domain.` } };
			}

			const attached = await attachDomain(domain);
			if (!attached.ok) return { ok: false, status: 502, body: { error: "vercel_refused", detail: attached.detail } };
			// Replacing a domain: let go of the old one only once the new one is held.
			if (vendor.custom_domain && vendor.custom_domain !== domain) await detachDomain(vendor.custom_domain);

			const row = { custom_domain: domain, custom_domain_verified_at: vendor.custom_domain === domain ? undefined : null };
			const { error } = await db.from("vendors").update(row).eq("id", vendorId);
			if (error) return { ok: false, status: error.code === "23505" ? 409 : 400, body: { error: error.code === "23505" ? "domain_taken" : error.message } };

			const state = await getDomainState(domain);
			return {
				ok: true,
				body: customDomainStatus({ custom_domain: domain, custom_domain_verified_at: null, proofs_published_at: vendor.proofs_published_at }, state),
			};
		},
	}),
	defineTool({
		// Same shape as verify_domain: asks Vercel now, and records success so the
		// proof page can name the custom domain canonical. A failed check never
		// clears an earlier success — DNS is allowed a bad minute.
		name: "check_custom_domain",
		description: "Check whether your proof domain's DNS is set up and record the result. No args.",
		capability: "vendor:write",
		inputSchema: S.checkCustomDomainInput,
		outputSchema: S.checkCustomDomainOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db
				.from("vendors")
				.select("custom_domain, custom_domain_verified_at, proofs_published_at")
				.eq("id", vendorId)
				.maybeSingle<CustomDomainRow>();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			if (!vendor.custom_domain || !customDomainsConfigured()) return { ok: true, body: customDomainStatus(vendor, null) };

			const state = await getDomainState(vendor.custom_domain);
			if (state && state.verified && !state.misconfigured) {
				const verifiedAt = new Date().toISOString();
				await db.from("vendors").update({ custom_domain_verified_at: verifiedAt }).eq("id", vendorId);
				vendor.custom_domain_verified_at = verifiedAt;
			}
			return { ok: true, body: customDomainStatus(vendor, state) };
		},
	}),
	defineTool({
		name: "get_custom_domain",
		description: "Your proof domain and its last recorded state, without checking DNS again. No args.",
		capability: "vendor:read",
		inputSchema: S.getCustomDomainInput,
		outputSchema: S.getCustomDomainOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db
				.from("vendors")
				.select("custom_domain, custom_domain_verified_at, proofs_published_at")
				.eq("id", vendorId)
				.maybeSingle<CustomDomainRow>();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			return { ok: true, body: customDomainStatus(vendor, null) };
		},
	}),
	defineTool({
		name: "remove_custom_domain",
		description: "Stop serving your proof page on your own domain. Your proof page stays on app.letterprove.com. No args.",
		capability: "vendor:write",
		inputSchema: S.removeCustomDomainInput,
		outputSchema: S.removeCustomDomainOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db.from("vendors").select("custom_domain").eq("id", vendorId).maybeSingle<{ custom_domain: string | null }>();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			if (!vendor.custom_domain) return { ok: true, body: { removed: false, domain: null } };

			const { error } = await db.from("vendors").update({ custom_domain: null, custom_domain_verified_at: null }).eq("id", vendorId);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			// Our side first: once the row is cleared the hostname serves nothing,
			// whatever Vercel says.
			if (customDomainsConfigured()) await detachDomain(vendor.custom_domain);
			return { ok: true, body: { removed: true, domain: vendor.custom_domain } };
		},
	}),
	defineTool({
		// See src/lib/vendors/hosts.ts for the trust rule: hosts under the
		// verified domain ride its proof; siblings need their own record.
		name: "add_host",
		description:
			"Accept events from another hostname on your verified domain, e.g. app.acme.com or www.acme.com. Hosts under your verified domain are accepted at once; a sibling (eu.acme.com when you verified app.acme.com) needs your TXT record on that host. Re-run to re-check. Args: host.",
		capability: "vendor:write",
		inputSchema: S.addHostInput,
		outputSchema: S.addHostOutput,
		handler: async (args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db
				.from("vendors")
				.select("domain, domain_verified_at, domain_verification_token")
				.eq("id", vendorId)
				.maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			// Every host's acceptance rests on DNS control of the domain.
			if (!vendor.domain_verified_at) {
				return { ok: false, status: 409, body: { error: "domain_not_verified", detail: "Verify your domain first; extra hosts are proven relative to it." } };
			}
			const check = classifyHost(String(asRecord(args).host ?? ""), vendor.domain);
			if (!check.ok) return { ok: false, status: 400, body: { error: check.error, detail: check.detail } };

			const { data: existing } = await db.from("vendor_hosts").select("vendor_id, host, proof, verified_at, created_at").eq("host", check.host).maybeSingle();
			if (existing && existing.vendor_id !== vendorId) {
				return { ok: false, status: 409, body: { error: "host_taken", detail: `${check.host} already belongs to another vendor.` } };
			}
			if (!existing) {
				const { data: mine } = await db.from("vendor_hosts").select("host").eq("vendor_id", vendorId);
				if ((mine ?? []).length >= MAX_HOSTS) return { ok: false, status: 409, body: { error: "too_many_hosts", detail: `At most ${MAX_HOSTS} extra hosts.` } };
			}

			let verifiedAt: string | null = existing?.verified_at ?? null;
			if (check.proof === "own_dns" && vendor.domain_verification_token) {
				const outcome = await checkHostVerification(check.host, vendor.domain_verification_token);
				// A failed lookup never clears an earlier success; DNS may have a bad minute.
				if (outcome.verified) verifiedAt = new Date().toISOString();
			}
			const row = {
				vendor_id: vendorId,
				host: check.host,
				proof: check.proof,
				verified_at: check.proof === "own_dns" ? verifiedAt : null,
				...(verifiedAt && check.proof === "own_dns" ? { dns_failures: 0, dns_failing_since: null } : {}),
			};
			const { error } = await db.from("vendor_hosts").upsert(row, { onConflict: "vendor_id,host" });
			if (error) return { ok: false, status: error.code === "23505" ? 409 : 400, body: { error: error.code === "23505" ? "host_taken" : error.message } };
			forgetAcceptedHosts(vendorId);
			const { data: saved } = await db
				.from("vendor_hosts")
				.select("host, proof, verified_at, created_at")
				.eq("vendor_id", vendorId)
				.eq("host", check.host)
				.single();
			return { ok: true, body: hostStatus(saved as HostRow, vendor.domain_verification_token) };
		},
	}),
	defineTool({
		name: "remove_host",
		description: "Stop accepting events from one of your extra hosts. Events already recorded from it stay. Args: host.",
		capability: "vendor:write",
		inputSchema: S.removeHostInput,
		outputSchema: S.removeHostOutput,
		handler: async (args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const host = normalizeDomain(String(asRecord(args).host ?? "")) ?? String(asRecord(args).host ?? "");
			const { data: held } = await db.from("vendor_hosts").select("host").eq("vendor_id", vendorId).eq("host", host).maybeSingle();
			if (!held) return { ok: true, body: { removed: false, host } };
			const { error } = await db.from("vendor_hosts").delete().eq("vendor_id", vendorId).eq("host", host);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			forgetAcceptedHosts(vendorId);
			return { ok: true, body: { removed: true, host } };
		},
	}),
	defineTool({
		name: "list_hosts",
		description: "Your verified domain plus every extra host events are accepted from, with whether each is accepted right now. No args.",
		capability: "vendor:read",
		inputSchema: S.listHostsInput,
		outputSchema: S.listHostsOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const { data: vendor } = await db.from("vendors").select("domain, domain_verification_token").eq("id", vendorId).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };
			const { data } = await db
				.from("vendor_hosts")
				.select("host, proof, verified_at, created_at")
				.eq("vendor_id", vendorId)
				.order("host", { ascending: true });
			return {
				ok: true,
				body: { domain: vendor.domain, hosts: ((data ?? []) as HostRow[]).map((r) => hostStatus(r, vendor.domain_verification_token)) },
			};
		},
	}),
];

export type DispatchOutcome =
	| { kind: "unknown_tool" }
	| { kind: "denied"; capability: Capability }
	| { kind: "result"; result: ToolResult };

export async function dispatchTool(
	name: string | undefined,
	args: unknown,
	principal: OAuthPrincipal,
	context: ToolContext = { origin: null },
): Promise<DispatchOutcome> {
	const tool = TOOLS.find((t) => t.name === name);
	if (!tool) return { kind: "unknown_tool" };

	if (!principal.capabilities.includes(tool.capability)) {
		return { kind: "denied", capability: tool.capability };
	}

	/**
	 * A staff capability in a token is not proof of being staff.
	 *
	 * The CLI client is registered with `allowed_scopes: ['*']`, which expands to
	 * every known capability — staff:* included — and the consent flow narrows
	 * only VENDOR scopes, by membership. So any signed-in user completing an
	 * ordinary `letterprove login` was granted staff:read and staff:write, which
	 * reach every vendor's withheld customer domains and can write customer
	 * records on any vendor's behalf. Signup is open, so "any signed-in user"
	 * means anyone.
	 *
	 * Checked HERE and not only at consent because consent decides what future
	 * grants contain; tokens already issued carry staff scopes until they expire.
	 * This is the only point that stops those.
	 */
	if (tool.capability.startsWith("staff:") && !isStaffUser(principal.userId)) {
		return { kind: "denied", capability: tool.capability };
	}

	/**
	 * A vendor capability in a token used to need a fresh membership recheck
	 * here, against `vendor_members` — dropped by
	 * 20260828130000_unify_auth_drop_local_identity.sql. Gone with the table:
	 * every principal now comes from authenticateToolRequest
	 * (src/lib/oauth-auth.ts), which always sets `orgId` — membership was
	 * already verified in Letterstory (organization_users) before the call, and
	 * Letterprove holds no membership of its own to recheck in the unified
	 * model. Trusting the service secret + the org it named is the whole point.
	 */

	const result = await tool.handler(args, principal, context);
	assertOutputMatchesSchema(tool, result);
	return { kind: "result", result };
}

/**
 * Checks that a tool returned what it declares, everywhere except production.
 *
 * An output schema is a claim about someone else's code, and the failure is
 * silent: a handler that renames a field, adds one, or starts returning null
 * keeps working perfectly, and only the contract becomes false. Nothing at
 * runtime notices, because nothing at runtime reads it.
 *
 * Doing the check HERE is what makes it nearly free: registry.test.ts already
 * drives every tool through real arguments, so each of those cases becomes a
 * conformance test, as does any test added later without its author knowing
 * this exists.
 *
 * PRODUCTION IS DELIBERATELY EXEMPT. A schema bug must never turn a working
 * vendor call into a 500: a wrong contract is a documentation problem, and
 * breaking the caller to announce it is strictly worse than serving the
 * payload and fixing the schema. Failures surface in CI, where they cost
 * nothing.
 *
 * Only successes are checked — errors all share ToolResult's uniform shape.
 */
function assertOutputMatchesSchema(tool: BoundTool, result: ToolResult): void {
	if (process.env.NODE_ENV === "production") return;
	if (!result.ok) return;

	const parsed = tool.outputSchema.safeParse(result.body);
	if (parsed.success) return;

	throw new Error(
		`${tool.name} returned a body its outputSchema rejects — the declared contract is wrong, or the handler is: ` +
			JSON.stringify(parsed.error.issues),
	);
}
