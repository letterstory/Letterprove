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

export const DISPLAY_SECTIONS = ["sessions", "reported_history", "logos", "payment_details", "observed_since", "hosts", "growth", "retention"] as const;
export type DisplaySection = (typeof DISPLAY_SECTIONS)[number];
/**
 * Whether the proof states how many companies pay, and which count:
 * "signed_in" = observed companies with a settled invoice in the bound Stripe
 * account; "all" = every company with a settled, in-scope invoice there,
 * observed or not. Hidden by default: it is an opt-in figure, not a section,
 * so it is never listed in hidden_by_vendor.
 */
export const PAYING_COUNT = ["hidden", "signed_in", "all"] as const;
export type PayingCount = (typeof PAYING_COUNT)[number];

export type DisplaySettings = Record<DisplaySection, boolean> & {
	paying_count: PayingCount;
	/** Name the verified companies on the logo wall, or show only the counts. */
	logo_names: boolean;
};

/** Always shown, whatever the vendor picks. */
export const LOCKED = ["domain", "tier", "companies_observed", "verify"] as const;

export const DEFAULT_DISPLAY: DisplaySettings = {
	sessions: true,
	reported_history: true,
	logos: true,
	payment_details: true,
	observed_since: true,
	hosts: true,
	growth: true,
	retention: true,
	paying_count: "hidden",
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
		if (typeof r.paying_count === "string" && (PAYING_COUNT as readonly string[]).includes(r.paying_count)) {
			out.paying_count = r.paying_count as PayingCount;
		}
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
	if (patch.paying_count && (PAYING_COUNT as readonly string[]).includes(patch.paying_count)) next.paying_count = patch.paying_count;
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
