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
	clearConsentToken,
	generateConsentLink,
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
import { generateKey } from "@/lib/vendors/keys";
import { sendSupportMessage } from "@/lib/support/slack";
import { sendConsentRequest } from "@/lib/email/consent";
import {
	saveCredential,
	connectionFor,
	disconnect as disconnectStripeCredential,
	type KeyRejection,
	type StripeConnection,
} from "@/lib/stripe/credentials";
import { syncVendorPayments } from "@/lib/stripe/sync";
import { paymentEvidenceCount } from "@/lib/attest/payment-evidence";

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
			"That is an unrestricted secret key (sk_). It can refund your customers, and publishing proof never needs that. Create a restricted key (rk_) with read access to Subscriptions, Customers and Invoices instead. Nothing was stored.",
	},
	publishable: {
		status: 400,
		detail: "That is a publishable key (pk_). It cannot read subscriptions at all. Create a restricted key (rk_) with read access to Subscriptions, Customers and Invoices instead. Nothing was stored.",
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
	};
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
		// The vendor-level proof rollup for the summary tab: headline tier +
		// counts. `list_snapshots` is per-customer and can't answer this. Returns
		// the slug so the caller builds the public /proofs, /attest URLs against
		// Letterprove's own origin (they must not point at the caller's host).
		name: "get_proof_summary",
		description: "Vendor-level proof rollup for the caller's vendor: headline tier, counts, and slug for public URLs.",
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
					attested_customers: summary.attested_customers,
					companies_observed: summary.companies_observed,
					sessions_30d: summary.sessions_30d,
					last_attested: summary.last_attested || null,
				},
			};
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
		description: "Create a customer for the caller's vendor. Args: slug, name, domain, since, consent?.",
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
		description: "Update one of the caller's customers. Args: slug (required), plus any of name, domain, since, consent, features.",
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
		name: "request_consent",
		description:
			"Email a customer the link to approve their own attestation — the tier-4 counter-signature. Args: slug (required), contact_email (required, must be an address on that customer's own domain). Re-issuing invalidates any link already sent. The link is never returned to the caller: it goes to the customer, which is what makes their approval evidence rather than the vendor's assertion.",
		capability: "vendor:write",
		inputSchema: S.requestConsentInput,
		outputSchema: S.requestConsentOutput,
		handler: async (args, principal, context) => {
			const record = asRecord(args);
			const slug = typeof record.slug === "string" ? record.slug : "";
			if (!slug) return { ok: false, status: 400, body: { error: "slug is required" } };
			const contactEmail = record.contact_email;

			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			// Same reasoning as get_install_snippet: the link has to be absolute
			// and must point at the host actually serving this app.
			if (!context.origin) return { ok: false, status: 400, body: { error: "origin_unavailable" } };
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };

			const { data: vendor } = await db.from("vendors").select("slug, name").eq("id", vendorId).maybeSingle();
			if (!vendor) return { ok: false, status: 404, body: { error: "not_found" } };

			const result = await generateConsentLink(db, vendorId, slug, contactEmail);
			if (!result.ok) return result;

			const sent = await sendConsentRequest({
				to: result.data.sentTo,
				vendorName: vendor.name,
				customerName: result.data.customerName,
				url: `${context.origin}/attest/${vendor.slug}/${slug}/consent?token=${result.data.token}`,
				expiresAt: result.data.expiresAt,
			});

			if (!sent.ok) {
				await clearConsentToken(db, vendorId, slug, result.data.token);
				return { ok: false, status: 502, body: { error: sent.error } };
			}

			return { ok: true, body: { sentTo: result.data.sentTo, expiresAt: result.data.expiresAt } };
		},
	}),
	defineTool({
		name: "get_status",
		description:
			"Whether the caller's vendor has received any events in the last 24h and how many, plus whether the tracking script has ever successfully checked in at all.",
		capability: "vendor:read",
		inputSchema: S.getStatusInput,
		outputSchema: S.getStatusOutput,
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const result = await getVendorStatus(vendorId);
			if (!result.ok) return { ok: false, status: result.status, body: { error: result.error } };
			return { ok: true, body: { receiving: result.receiving, installed: result.installed, count: result.count } };
		},
	}),
	defineTool({
		name: "list_observed",
		description:
			"Companies the caller's vendor has been observed serving in the publishing window, with what each one is blocked on. Args: none. Read-only — use record_customer to turn one into a customer record.",
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
		description:
			"Every vendor with the humans behind it, their customer counts, and what their aggregate attestation currently claims. Args: none.",
		capability: "staff:read",
		inputSchema: S.vendorRosterInput,
		outputSchema: S.vendorRosterOutput,
		/*
		 * Same story as collection_health: the /staff/vendors page read
		 * vendorRoster() directly and lost its home in #124.
		 *
		 * Note this returns member EMAIL ADDRESSES, which nothing else in the
		 * tool surface does. That is deliberate and is exactly why it is
		 * staff:read and not vendor:read — it is the support view for "who do
		 * I talk to about this vendor", and a vendor must never be able to
		 * enumerate the humans behind another one.
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
		name: "get_install_snippet",
		description: "The <script> tag to install on the caller's site, pointed at this server's own origin. Args: none.",
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
			const { data: vendor } = await db.from("vendors").select("key").eq("id", vendorId).maybeSingle();
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
			const { error } = await db.from("vendors").update({ domain_verified_at: verifiedAt }).eq("id", vendorId);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			return {
				ok: true,
				body: { domain: vendor.domain, verified: true, checked: true, message, verified_at: verifiedAt },
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

			const { error } = await db.from("vendors").update(update).eq("id", vendorId);
			if (error) return { ok: false, status: 400, body: { error: error.message } };
			return { ok: true, body: { vendor: { ...vendor, ...update } } };
		},
	}),
	defineTool({
		name: "list_snapshots",
		description:
			"Attestation chain summaries for the caller's customers — chain length and current snapshot. Args: customer (slug, optional — every customer if omitted).",
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
			"Store a Stripe RESTRICTED key (rk_) for the caller's vendor, so payments can corroborate customers at tier 3. Args: restricted_key, which needs read access to Subscriptions, Customers and Invoices. An unrestricted sk_ or publishable pk_ key is refused. The key is never returned.",
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

			const saved = await saveCredential(vendorId, submitted);
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
				},
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
	 * A vendor capability in a token is not proof of current membership,
	 * for the same reason staff isn't, above: consent no longer verifies
	 * vendor_members before minting the grant (see the consent route), so a
	 * token can carry vendor:* for a vendor_id the user doesn't actually
	 * belong to, or belonged to and was later removed from. Checked here,
	 * fresh, on every call — membership can change after a token is minted
	 * and tokens keep their scope until they expire.
	 */
	//
	// Skipped for a Letterstory-service principal (principal.orgId set): its
	// membership was already verified in Letterstory (organization_users) before
	// the call, and the acting user has no vendor_members row here by design —
	// Letterprove holds no membership of its own in the unified model. Trusting
	// the service secret + the org it named is the whole point of that model.
	if (tool.capability.startsWith("vendor:") && principal.orgId == null) {
		const db = dbClient();
		// A null db means unconfigured, not unauthorized — let the handler's own
		// dbClient() check produce its usual storage_unavailable rather than
		// this turning into a denial that has nothing to do with membership.
		if (db) {
			const { data: membership } = await db
				.from("vendor_members")
				.select("vendor_id")
				.eq("vendor_id", principal.vendorId ?? "")
				.eq("user_id", principal.userId)
				.maybeSingle();
			if (!membership) return { kind: "denied", capability: tool.capability };
		}
	}

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
