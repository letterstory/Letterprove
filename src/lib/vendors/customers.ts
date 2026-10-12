import type { SupabaseClient } from "@supabase/supabase-js";
import { FEATURES, type Consent } from "@/lib/fixtures/vendors";
import { classifyDomain } from "@/lib/identity/domains";

/** Slugs that would publish to an unreachable URL — see attest/[vendor]/chain. */
const RESERVED_CUSTOMER_SLUGS = new Set(["chain"]);

const FEATURE_SET: readonly string[] = FEATURES;

/**
 * The calling vendor's own domain, for the self-dealing check in
 * classifyDomain. Looked up here rather than threaded in by every caller —
 * the session route already has it on hand (`currentVendor()`), but the
 * bearer-token dispatcher only resolves a vendorId, and a check this
 * security-relevant shouldn't depend on every caller remembering to pass it
 * correctly. RLS ("vendor members can read their own vendor") covers the
 * session client the same way it covers everything else here; the
 * service-role client just reads the row directly.
 */
async function vendorOwnDomain(supabase: SupabaseClient, vendorId: string): Promise<string | undefined> {
	const { data } = await supabase.from("vendors").select("domain").eq("id", vendorId).maybeSingle();
	return data?.domain ?? undefined;
}

export type CustomerRow = {
	id: string;
	slug: string;
	name: string;
	domain: string;
	since: string;
	tier: number;
	verified: boolean;
	features: string[];
	consent: Consent;
};

/**
 * Exported so the drift that once hid a column from the dashboard can be
 * asserted against rather than re-introduced: the vendor customers page used
 * to repeat this list by hand, and when a column was added here the page kept
 * selecting the old set. Every reader goes through listCustomers(); this
 * constant is exported for the guard test, not for building queries elsewhere.
 */
export const CUSTOMER_COLUMNS =
	"id, slug, name, domain, since, tier, verified, features, consent";

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Single source of truth for the vendor-customer CRUD business logic
 * (domain gate, reserved slugs, provenance-field stripping). Both the
 * cookie-session route (src/app/api/vendor/customers) and the bearer-token
 * tool dispatcher (src/lib/tools/registry.ts) call these, scoped by whatever
 * vendorId their own auth resolved — RLS on `vendor_customers` covers the
 * session client, and the explicit `.eq("vendor_id", vendorId)` covers the
 * service-role client the same way (see feedback_rls_trust_pattern).
 */
export async function listCustomers(
	supabase: SupabaseClient,
	vendorId: string,
): Promise<ServiceResult<CustomerRow[]>> {
	const { data, error } = await supabase
		.from("vendor_customers")
		.select(CUSTOMER_COLUMNS)
		.eq("vendor_id", vendorId)
		.order("created_at", { ascending: true });

	if (error) return { ok: false, status: 400, body: { error: error.message } };
	return { ok: true, data: (data ?? []) as CustomerRow[] };
}

export type CreateCustomerInput = {
	slug: unknown;
	name: unknown;
	domain: unknown;
	since: unknown;
	consent?: unknown;
};

export async function createCustomer(
	supabase: SupabaseClient,
	vendorId: string,
	input: CreateCustomerInput,
): Promise<ServiceResult<CustomerRow>> {
	if (
		typeof input.slug !== "string" ||
		typeof input.name !== "string" ||
		typeof input.domain !== "string" ||
		typeof input.since !== "string" ||
		!input.slug.trim() ||
		!input.name.trim() ||
		!input.domain.trim() ||
		!input.since.trim()
	) {
		return { ok: false, status: 400, body: { error: "slug, name, domain, and since are required" } };
	}

	const slug = input.slug.trim();
	if (RESERVED_CUSTOMER_SLUGS.has(slug.toLowerCase())) {
		return {
			ok: false,
			status: 422,
			body: { error: `"${slug}" is a reserved slug`, reason: "it collides with a published route" },
		};
	}

	const domain = input.domain.trim();
	const classified = classifyDomain(domain, await vendorOwnDomain(supabase, vendorId));
	if (classified.kind !== "company") {
		return {
			ok: false,
			status: 422,
			body: { error: `"${domain}" cannot be a customer`, reason: classified.reason, kind: classified.kind },
		};
	}

	const consent: Consent = input.consent === "named" ? "named" : "anonymous";

	const { data, error } = await supabase
		.from("vendor_customers")
		.insert({
			vendor_id: vendorId,
			slug,
			name: input.name.trim(),
			domain,
			since: input.since.trim(),
			consent,
			tier: 1,
			verified: false,
			features: [],
		})
		.select(CUSTOMER_COLUMNS)
		.single();

	if (error) return { ok: false, status: 400, body: { error: error.message } };
	return { ok: true, data: data as CustomerRow };
}

export type UpdateCustomerInput = {
	name?: unknown;
	domain?: unknown;
	since?: unknown;
	consent?: unknown;
	features?: unknown;
};

export async function updateCustomer(
	supabase: SupabaseClient,
	vendorId: string,
	slug: string,
	input: UpdateCustomerInput,
): Promise<ServiceResult<CustomerRow>> {
	const update: Record<string, unknown> = {};
	if (typeof input.name === "string" && input.name.trim()) update.name = input.name.trim();
	if (typeof input.domain === "string" && input.domain.trim()) {
		// Same refusal as creation — gating only create would leave the rule
		// trivially bypassable (make a customer on a real domain, then edit it).
		const domain = input.domain.trim();
		const classified = classifyDomain(domain, await vendorOwnDomain(supabase, vendorId));
		if (classified.kind !== "company") {
			return {
				ok: false,
				status: 422,
				body: { error: `"${domain}" cannot be a customer`, reason: classified.reason, kind: classified.kind },
			};
		}
		update.domain = domain;
	}
	if (typeof input.since === "string" && input.since.trim()) update.since = input.since.trim();
	if (input.consent === "named" || input.consent === "anonymous") {
		update.consent = input.consent as Consent;
	}
	if (Array.isArray(input.features)) {
		update.features = input.features.filter(
			(f: unknown): f is string => typeof f === "string" && FEATURE_SET.includes(f),
		);
	}

	if (Object.keys(update).length === 0) {
		return { ok: false, status: 400, body: { error: "no updatable fields provided" } };
	}

	const { data, error } = await supabase
		.from("vendor_customers")
		.update(update)
		.eq("vendor_id", vendorId)
		.eq("slug", slug)
		.select(CUSTOMER_COLUMNS)
		.maybeSingle();

	if (error) return { ok: false, status: 400, body: { error: error.message } };
	if (!data) return { ok: false, status: 404, body: { error: "not_found" } };
	return { ok: true, data: data as CustomerRow };
}

export async function deleteCustomer(
	supabase: SupabaseClient,
	vendorId: string,
	slug: string,
): Promise<ServiceResult<{ id: string }>> {
	const { data, error } = await supabase
		.from("vendor_customers")
		.delete()
		.eq("vendor_id", vendorId)
		.eq("slug", slug)
		.select("id")
		.maybeSingle();

	if (error) return { ok: false, status: 400, body: { error: error.message } };
	if (!data) return { ok: false, status: 404, body: { error: "not_found" } };
	return { ok: true, data };
}
