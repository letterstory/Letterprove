import { dbClient } from "@/lib/db/client";
import { currentSnapshot } from "@/rollup/snapshots";

/**
 * The public, unauthenticated half of the consent flow — a vendor's own
 * customer, visiting a link the vendor generated (see generateConsentLink in
 * customers.ts), with no Letterprove account of their own. Everything here
 * goes through the service-role client on purpose: there is no session to
 * scope an anon-key client to, and the unguessable token in the URL is the
 * only credential this caller has. That token — not RLS — is what
 * authorizes the read and the write below.
 */

export type ConsentPreview = {
	vendorSlug: string;
	vendorName: string;
	customerSlug: string;
	customerName: string;
	domain: string;
	since: string;
	features: string[];
	sessions30d: number;
	seatsActive: number;
};

export type ConsentLookup =
	| { status: "ready"; preview: ConsentPreview }
	| { status: "already_countersigned"; customerName: string }
	| { status: "expired" }
	| { status: "invalid" };

export async function lookupConsentRequest(
	vendorSlug: string,
	customerSlug: string,
	token: string,
): Promise<ConsentLookup> {
	const db = dbClient();
	if (!db) return { status: "invalid" };

	const { data: vendorRow } = await db.from("vendors").select("id, name").eq("slug", vendorSlug).maybeSingle();
	if (!vendorRow) return { status: "invalid" };

	const { data: customer } = await db
		.from("vendor_customers")
		.select("name, domain, since, features, consent_token, consent_token_expires_at, countersigned_at")
		.eq("vendor_id", vendorRow.id)
		.eq("slug", customerSlug)
		.maybeSingle();
	if (!customer) return { status: "invalid" };

	// Checked ahead of the token match on purpose: approving clears
	// consent_token (see recordConsentDecision), so a customer re-opening the
	// same email link afterward would otherwise see "invalid link" instead of
	// "you already did this" — a strictly worse answer to the same state.
	if (customer.countersigned_at) return { status: "already_countersigned", customerName: customer.name };

	if (!customer.consent_token || customer.consent_token !== token) return { status: "invalid" };
	if (!customer.consent_token_expires_at || new Date(customer.consent_token_expires_at) < new Date()) {
		return { status: "expired" };
	}

	const snapshot = await currentSnapshot(vendorSlug, customer.domain);
	return {
		status: "ready",
		preview: {
			vendorSlug,
			vendorName: vendorRow.name,
			customerSlug,
			customerName: customer.name,
			domain: customer.domain,
			since: customer.since,
			features: customer.features,
			sessions30d: snapshot.sessions_30d,
			seatsActive: snapshot.seats_active,
		},
	};
}

export type ConsentDecision = "approve" | "decline";

/**
 * The write side. Approving is the tier-4 counter-signature itself (README §
 * Consent) — it sets `consent: "named"` and `countersigned_at` together,
 * since the customer reviewing and approving their own attestation is both
 * the strongest evidence in the system and their actual consent to be named.
 * Declining touches neither; it only clears the token so the link can't be
 * replayed.
 *
 * The update is scoped by vendor_id + slug + the exact live, unexpired token
 * in one statement — that scoping is the real authorization check, not the
 * read in lookupConsentRequest, which a second open tab could otherwise race
 * against.
 */
export async function recordConsentDecision(
	vendorSlug: string,
	customerSlug: string,
	token: string,
	decision: ConsentDecision,
): Promise<{ ok: true } | { ok: false; reason: "invalid" }> {
	const db = dbClient();
	if (!db) return { ok: false, reason: "invalid" };

	const { data: vendorRow } = await db.from("vendors").select("id").eq("slug", vendorSlug).maybeSingle();
	if (!vendorRow) return { ok: false, reason: "invalid" };

	// Which address this link was delivered to, so an approval can record who
	// made it. Read under the same predicates as the update below; the update
	// is still the authoritative check, so a link that gets used or re-issued
	// between these two statements simply matches nothing and we bail.
	const { data: pending } = await db
		.from("vendor_customers")
		.select("consent_sent_to")
		.eq("vendor_id", vendorRow.id)
		.eq("slug", customerSlug)
		.eq("consent_token", token)
		.maybeSingle();

	const patch =
		decision === "approve"
			? {
					consent: "named" as const,
					countersigned_at: new Date().toISOString(),
					// Provenance for the counter-signature: countersigned_at says a
					// customer approved, this says which address did. Not published —
					// naming the individual would be a privacy leak the customer never
					// agreed to. It exists so a disputed claim can be traced.
					countersigned_by: pending?.consent_sent_to ?? null,
					consent_token: null,
					consent_token_expires_at: null,
					consent_sent_to: null,
				}
			: { consent_token: null, consent_token_expires_at: null, consent_sent_to: null };

	const { data, error } = await db
		.from("vendor_customers")
		.update(patch)
		.eq("vendor_id", vendorRow.id)
		.eq("slug", customerSlug)
		.eq("consent_token", token)
		.gt("consent_token_expires_at", new Date().toISOString())
		.select("id")
		.maybeSingle();

	if (error || !data) return { ok: false, reason: "invalid" };
	return { ok: true };
}
