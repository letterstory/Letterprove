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
import { vendorSlugs } from "@/lib/attest/proofs";

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

export type ToolHandler = (args: unknown, principal: OAuthPrincipal) => Promise<ToolResult>;

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
];

export type DispatchOutcome =
	| { kind: "unknown_tool" }
	| { kind: "denied"; capability: Capability }
	| { kind: "result"; result: ToolResult };

export async function dispatchTool(
	name: string | undefined,
	args: unknown,
	principal: OAuthPrincipal,
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

	const result = await tool.handler(args, principal);
	return { kind: "result", result };
}
