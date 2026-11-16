/**
 * Case studies (2026-11-14, Mathew: "That publishes it to a Letter Proof URL, and then you can decide to make a pull
 * request to put it onto your website").
 *
 * WHERE IT COMES FROM. Letter's script on the vendor's own product counts which people and companies sign in and what
 * they use; Letter finds the patterns in that record and writes a short case study from them, every number one of the
 * facts' numbers, naming companies only when the vendor chose to. Letter publishes it here (publish_case_study) and
 * takes it down (unpublish_case_study).
 *
 * WHAT IS PUBLISHED. The headline, the paragraphs and the facts they rest on, at /case-studies/<id>, labelled as the
 * vendor's usage data counted by Letter. Like feature usage it is vendor-stated: never signed, never moving the tier.
 * The id is Letter's, so a republish lands at the same URL.
 */

import { dbClient } from "@/lib/db/client";
import { VERIFY_ORIGIN } from "@/lib/attest/verify-link";

/** The table isn't there yet (its migration not applied): Letter serves the case study itself until it is. */
const missingTable = (error: { code?: string } | null) => !!error && (error.code === "PGRST205" || error.code === "42P01");

export interface CaseStudyInput {
	id: string;
	headline: string;
	paragraphs: string[];
	facts: { text: string; numbers: number[] }[];
	window: { since: string; until: string; days: number };
	anonymization: "counts_only" | "companies_named";
	named_companies: string[];
	source: "letter_usage_data";
}

export interface PublicCaseStudy {
	id: string;
	headline: string;
	paragraphs: string[];
	facts: { text: string; numbers: number[] }[];
	window: { since: string; until: string; days: number };
	published_at: string;
	vendor: { name: string; domain: string | null; slug: string };
}

/** The public page of a case study. */
export function caseStudyUrl(id: string, origin: string = VERIFY_ORIGIN): string {
	return `${origin}/case-studies/${encodeURIComponent(id)}`;
}

/** Publish (or republish in place) the vendor's case study. False when storage is unavailable or the id is another vendor's. */
export async function publishCaseStudy(vendorId: string, input: CaseStudyInput): Promise<"ok" | "storage_unavailable" | "not_yours" | "not_ready"> {
	const db = dbClient();
	if (!db) return "storage_unavailable";
	const { data: existing, error: readError } = await db.from("vendor_case_studies").select("vendor_id").eq("id", input.id).maybeSingle();
	if (readError) return missingTable(readError) ? "not_ready" : "storage_unavailable";
	if (existing && existing.vendor_id !== vendorId) return "not_yours";
	const { error } = await db.from("vendor_case_studies").upsert(
		{
			id: input.id,
			vendor_id: vendorId,
			headline: input.headline,
			paragraphs: input.paragraphs,
			facts: input.facts,
			window_since: input.window.since,
			window_until: input.window.until,
			window_days: input.window.days,
			anonymization: input.anonymization,
			named_companies: input.anonymization === "companies_named" ? input.named_companies : [],
			source: input.source,
			published_at: new Date().toISOString(),
			removed_at: null,
		},
		{ onConflict: "id" },
	);
	return error ? "storage_unavailable" : "ok";
}

/** Take the vendor's case study down. `removed` is false when it was never here, or already down. */
export async function unpublishCaseStudy(vendorId: string, id: string): Promise<{ removed: boolean } | "not_ready" | null> {
	const db = dbClient();
	if (!db) return null;
	const { data, error } = await db
		.from("vendor_case_studies")
		.update({ removed_at: new Date().toISOString() })
		.eq("id", id)
		.eq("vendor_id", vendorId)
		.is("removed_at", null)
		.select("id");
	if (error) return missingTable(error) ? "not_ready" : null;
	return { removed: (data ?? []).length > 0 };
}

/** A published case study with its vendor, for the public page; null when unknown, taken down, or storage is unavailable. */
export async function loadCaseStudy(id: string): Promise<PublicCaseStudy | null> {
	if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
	const db = dbClient();
	if (!db) return null;
	const { data, error } = await db
		.from("vendor_case_studies")
		.select("id, headline, paragraphs, facts, window_since, window_until, window_days, published_at, vendors(name, domain, slug)")
		.eq("id", id)
		.is("removed_at", null)
		.maybeSingle();
	if (error || !data) return null;
	const vendor = (Array.isArray(data.vendors) ? data.vendors[0] : data.vendors) as { name: string; domain: string | null; slug: string } | null;
	if (!vendor) return null;
	return {
		id: data.id as string,
		headline: data.headline as string,
		paragraphs: data.paragraphs as string[],
		facts: (data.facts ?? []) as PublicCaseStudy["facts"],
		window: {
			since: data.window_since as string,
			until: data.window_until as string,
			days: data.window_days as number,
		},
		published_at: data.published_at as string,
		vendor,
	};
}
