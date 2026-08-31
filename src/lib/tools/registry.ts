import type { OAuthPrincipal, Capability } from "@/lib/oauth/scopes";
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
	handler: ToolHandler;
};

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

export const TOOLS: ToolDef[] = [
	{
		// Pre-vendor: asked first by Letterstory's Proofs tab to decide whether
		// to show the surface or the setup flow. Keys on the org, not a vendor.
		name: "find_vendor_by_org",
		description: "Does a Letterstory org already have a Letterprove vendor? Returns { linked }.",
		capability: "vendor:read",
		handler: async (_args, principal) => {
			const orgId = requireOrgId(principal);
			if (typeof orgId !== "string") return orgId;

			const vendor = await findVendorByOrg(orgId);
			if (!vendor) return { ok: true, body: { linked: false } };
			return { ok: true, body: { linked: true, slug: vendor.slug, domain: vendor.domain } };
		},
	},
	{
		// Pre-vendor: the setup flow's write. Creates the vendor and links it to
		// the org 1:1. Authorized by the Letterstory service secret (the org
		// context), NOT by a vendor:* grant — no vendor exists to grant against.
		name: "create_vendor",
		description: "Create the Letterprove vendor for a Letterstory org, linked 1:1. Args: name, domain. Returns { linked }.",
		capability: "vendor:write",
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
	},
	{
		// The vendor-level proof rollup for the summary tab: headline tier +
		// counts. `list_snapshots` is per-customer and can't answer this. Returns
		// the slug so the caller builds the public /proofs, /attest URLs against
		// Letterprove's own origin (they must not point at the caller's host).
		name: "get_proof_summary",
		description: "Vendor-level proof rollup for the caller's vendor: headline tier, counts, and slug for public URLs.",
		capability: "vendor:read",
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
	},
	{
		// The vendor-scoped twin of the staff-only `record_customer`: a vendor
		// (via Letterstory) turns one of its OWN observed domains into a customer.
		// Scoped to principal.vendorId, so it needs vendor:write, not the
		// cross-vendor staff:write `record_customer` carries — the Letterstory
		// service principal deliberately holds no staff capability.
		name: "record_observed",
		description:
			"Record one of the caller's own observed companies as a customer (anonymous, tier-1 ceiling). Args: domain.",
		capability: "vendor:write",
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
	},
	{
		name: "list_customers",
		description: "List every customer recorded for the caller's vendor.",
		capability: "vendor:read",
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await listCustomers(db, vendorId);
			if (!result.ok) return result;
			return { ok: true, body: { customers: result.data } };
		},
	},
	{
		name: "create_customer",
		description: "Create a customer for the caller's vendor. Args: slug, name, domain, since, consent?.",
		capability: "vendor:write",
		handler: async (args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await createCustomer(db, vendorId, asRecord(args) as CreateCustomerInput);
			if (!result.ok) return result;
			return { ok: true, status: 201, body: { customer: result.data } };
		},
	},
	{
		name: "update_customer",
		description: "Update one of the caller's customers. Args: slug (required), plus any of name, domain, since, consent, features.",
		capability: "vendor:write",
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
	},
	{
		name: "delete_customer",
		description: "Delete one of the caller's customers. Args: slug (required).",
		capability: "vendor:write",
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
	},
	{
		name: "request_consent",
		description:
			"Email a customer the link to approve their own attestation — the tier-4 counter-signature. Args: slug (required), contact_email (required, must be an address on that customer's own domain). Re-issuing invalidates any link already sent. The link is never returned to the caller: it goes to the customer, which is what makes their approval evidence rather than the vendor's assertion.",
		capability: "vendor:write",
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
	},
	{
		name: "get_status",
		description:
			"Whether the caller's vendor has received any events in the last 24h and how many, plus whether the tracking script has ever successfully checked in at all.",
		capability: "vendor:read",
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const result = await getVendorStatus(vendorId);
			if (!result.ok) return { ok: false, status: result.status, body: { error: result.error } };
			return { ok: true, body: { receiving: result.receiving, installed: result.installed, count: result.count } };
		},
	},
	{
		name: "list_observed",
		description:
			"Companies the caller's vendor has been observed serving in the publishing window, with what each one is blocked on. Args: none. Read-only — use record_customer to turn one into a customer record.",
		capability: "vendor:read",
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
	},
	{
		name: "record_customer",
		description:
			"Turn a domain observed for a vendor into a customer record (anonymous, tier-1 ceiling). Args: vendor (slug), domain.",
		capability: "staff:write",
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
	},
	{
		name: "collection_health",
		description:
			"Fleet-wide collection health: per vendor, whether the tracking script is reporting, silent, installed-but-quiet, or was never installed, with event counts over 24h/7d/30d. Args: none.",
		capability: "staff:read",
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
	},
	{
		name: "vendor_roster",
		description:
			"Every vendor with the humans behind it, their customer counts, and what their aggregate attestation currently claims. Args: none.",
		capability: "staff:read",
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
	},
	{
		name: "tier_report",
		description:
			"Per-domain tier status for a vendor: what's observed, what's a customer record, what's actually published. Args: vendor (slug, optional — every vendor if omitted).",
		capability: "staff:read",
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
	},
	{
		name: "get_install_snippet",
		description: "The <script> tag to install on the caller's site, pointed at this server's own origin. Args: none.",
		capability: "vendor:read",
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
	},
	{
		name: "rotate_key",
		description:
			"Replace the caller's vendor publishable/collector key with a freshly generated one. The old key stops working immediately — every existing install must be updated. Args: none.",
		capability: "vendor:write",
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
	},
	{
		name: "verify_domain",
		description:
			"Check DNS for this vendor's domain-verification TXT record and record the result. No args.",
		capability: "vendor:write",
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
	},
	{
		name: "update_vendor",
		description: "Update the caller's own vendor account. Args: any of name, domain, category.",
		capability: "vendor:write",
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
	},
	{
		name: "list_snapshots",
		description:
			"Attestation chain summaries for the caller's customers — chain length and current snapshot. Args: customer (slug, optional — every customer if omitted).",
		capability: "vendor:read",
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
	},
	{
		name: "submit_support_request",
		description: "Send a support message to the team, attributed to the caller's vendor and account. Args: message.",
		capability: "vendor:write",
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
	},
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
	return { kind: "result", result };
}
