import type { OAuthPrincipal } from "@/lib/oauth/core";
import type { Capability } from "@/lib/oauth/scopes";
import { dbClient } from "@/lib/db/client";
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
import { tierReport } from "@/lib/tiers/report";
import { vendorSlugs, vendorSnapshots } from "@/lib/attest/proofs";
import { installSnippet } from "@/lib/vendors/install";
import { generateKey } from "@/lib/vendors/keys";

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

// vendorId is only null for a staff-only grant (see OAuthPrincipal), which
// never carries a vendor:* capability — dispatchTool's capability gate means a
// vendor:* tool handler is unreachable with a null vendorId in practice. This
// turns that invariant into a typed, checked value instead of a `!` assertion,
// so a future bug in the gate fails as a clean 500 rather than a bad query.
function requireVendorId(principal: OAuthPrincipal): string | ToolResult {
	if (principal.vendorId) return principal.vendorId;
	return { ok: false, status: 500, body: { error: "vendor_scope_without_vendor" } };
}

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
		name: "get_status",
		description: "Whether the caller's vendor has received any events in the last 24h, and how many.",
		capability: "vendor:read",
		handler: async (_args, principal) => {
			const vendorId = requireVendorId(principal);
			if (typeof vendorId !== "string") return vendorId;
			const result = await getVendorStatus(vendorId);
			if (!result.ok) return { ok: false, status: result.status, body: { error: result.error } };
			return { ok: true, body: { receiving: result.receiving, count: result.count } };
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
			return { ok: true, body: { snippet: installSnippet(context.origin, vendor.key), origin: context.origin } };
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
	if (tool.capability.startsWith("vendor:")) {
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
