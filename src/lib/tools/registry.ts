import type { OAuthPrincipal } from "@/lib/oauth/core";
import type { Capability } from "@/lib/oauth/scopes";
import { dbClient } from "@/lib/db/client";
import {
	listCustomers,
	createCustomer,
	updateCustomer,
	deleteCustomer,
	type CreateCustomerInput,
	type UpdateCustomerInput,
} from "@/lib/vendors/customers";
import { getVendorStatus } from "@/lib/vendors/status";

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

export const TOOLS: ToolDef[] = [
	{
		name: "list_customers",
		description: "List every customer recorded for the caller's vendor.",
		capability: "vendor:read",
		handler: async (_args, principal) => {
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await listCustomers(db, principal.vendorId);
			if (!result.ok) return result;
			return { ok: true, body: { customers: result.data } };
		},
	},
	{
		name: "create_customer",
		description: "Create a customer for the caller's vendor. Args: slug, name, domain, since, consent?.",
		capability: "vendor:write",
		handler: async (args, principal) => {
			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await createCustomer(db, principal.vendorId, asRecord(args) as CreateCustomerInput);
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

			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await updateCustomer(db, principal.vendorId, slug, record as UpdateCustomerInput);
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

			const db = dbClient();
			if (!db) return { ok: false, status: 503, body: { error: "storage_unavailable" } };
			const result = await deleteCustomer(db, principal.vendorId, slug);
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
			const result = await getVendorStatus(principal.vendorId);
			if (!result.ok) return { ok: false, status: result.status, body: { error: result.error } };
			return { ok: true, body: { receiving: result.receiving, count: result.count } };
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

	const result = await tool.handler(args, principal);
	return { kind: "result", result };
}
