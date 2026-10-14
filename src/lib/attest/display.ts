/**
 * What a vendor shows on its public proof.
 *
 * Optional sections can be hidden; the core of the claim cannot. The domain,
 * the tier, companies observed and the verify link are what the proof IS, so
 * a vendor can't remove them. Whatever is hidden is listed in the
 * attestation's `hidden_by_vendor`, so an agent reading the proof knows a
 * section is missing by the vendor's choice, not because there is no data.
 */

import { dbClient } from "@/lib/db/client";

export const DISPLAY_SECTIONS = ["sessions", "reported_history", "logos", "stripe_business", "observed_since", "hosts", "growth", "retention"] as const;
export type DisplaySection = (typeof DISPLAY_SECTIONS)[number];
export type DisplaySettings = Record<DisplaySection, boolean> & {
	/** Name the verified companies on the logo wall, or show only the counts. */
	logo_names: boolean;
};

/** Always shown, whatever the vendor picks. */
export const LOCKED = ["domain", "tier", "companies_observed", "verify"] as const;

export const DEFAULT_DISPLAY: DisplaySettings = {
	sessions: true,
	reported_history: true,
	logos: true,
	stripe_business: true,
	observed_since: true,
	hosts: true,
	growth: true,
	retention: true,
	logo_names: true,
};

/** Normalize whatever is stored: unknown keys dropped, absent keys shown. */
export function normalizeDisplay(raw: unknown): DisplaySettings {
	const out: DisplaySettings = { ...DEFAULT_DISPLAY };
	if (raw && typeof raw === "object") {
		for (const k of DISPLAY_SECTIONS) {
			const v = (raw as Record<string, unknown>)[k];
			if (typeof v === "boolean") out[k] = v;
		}
		const r = raw as Record<string, unknown>;
		// paying_count and payment_details are retired (2026-10-14): ignored if stored.
		if (typeof r.logo_names === "boolean") out.logo_names = r.logo_names;
	}
	return out;
}

/** The section names the vendor hid, in a stable order. */
export function hiddenSections(display: DisplaySettings): DisplaySection[] {
	return DISPLAY_SECTIONS.filter((k) => !display[k]);
}

/** Shown-everything on any read failure: hiding is the vendor's choice, never ours. */
export async function displayFor(vendorId: string): Promise<DisplaySettings> {
	const db = dbClient();
	if (!db) return { ...DEFAULT_DISPLAY };
	try {
		const { data, error } = await db.from("vendors").select("proof_display").eq("id", vendorId).maybeSingle<{ proof_display: unknown }>();
		if (error || !data) return { ...DEFAULT_DISPLAY };
		return normalizeDisplay(data.proof_display);
	} catch {
		return { ...DEFAULT_DISPLAY };
	}
}

/** Merge a partial update into what's stored. Locked names are rejected by the caller. */
export async function setDisplay(vendorId: string, patch: Partial<DisplaySettings>): Promise<DisplaySettings | null> {
	const db = dbClient();
	if (!db) return null;
	const next = { ...(await displayFor(vendorId)) };
	for (const k of DISPLAY_SECTIONS) {
		if (typeof patch[k] === "boolean") next[k] = patch[k] as boolean;
	}
	if (typeof patch.logo_names === "boolean") next.logo_names = patch.logo_names;
	const { error } = await db.from("vendors").update({ proof_display: next }).eq("id", vendorId);
	return error ? null : next;
}

/**
 * The vendor's CURRENT display settings by slug. Pages read the signed snapshot,
 * which only picks up a change at the next hourly cut; a vendor who hides a
 * section expects it gone now, so the human pages also check this.
 */
export async function displayForSlug(slug: string): Promise<DisplaySettings> {
	const db = dbClient();
	if (!db) return { ...DEFAULT_DISPLAY };
	try {
		const { data, error } = await db.from("vendors").select("proof_display").eq("slug", slug).maybeSingle<{ proof_display: unknown }>();
		if (error || !data) return { ...DEFAULT_DISPLAY };
		return normalizeDisplay(data.proof_display);
	} catch {
		return { ...DEFAULT_DISPLAY };
	}
}
