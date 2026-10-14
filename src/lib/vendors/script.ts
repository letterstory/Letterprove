/**
 * The Letterprove script, attestation only (since 2026-10-14).
 *
 * attest.js collects sign-ins for the vendor's proof and nothing else. Agent
 * visits and visitor identification are the Visitors product: a separate
 * script on a separate key (lettervisit.com/v.js, served by the Letterstory
 * app). The one switch left is `proofs`: whether sign-ins are collected.
 * /v1/config tells attest.js, and /v1/observe drops events when it is off (the
 * config is CDN-cached for minutes, so the server side makes "off" final).
 *
 * The visitor columns on `vendors` (module_agent_visitors, server_seen_at,
 * visitors_script_seen_at, visitor_identification_*) are no longer read or
 * written; a later migration drops them.
 */

import { dbClient } from "@/lib/db/client";

export interface ScriptModules {
	proofs: boolean;
}

export interface ScriptStatus {
	/** First config fetch from any copy of the script. */
	script_seen_at: string | null;
	/** First config fetch from attest.js, recorded once. */
	proofs_script_seen_at: string | null;
	last_script_seen_at: string | null;
	first_signin_at: string | null;
	domain_verified: boolean;
}

const MEMO_MS = 60_000;
const memo = new Map<string, { at: number; modules: ScriptModules }>();

/** Test seam. */
export function _resetModuleMemo(): void {
	memo.clear();
}

/**
 * Whether sign-ins are collected, read by the collectors. Memoised a minute per
 * instance; fails open (on), since a failed read must never silently stop a
 * vendor's collection.
 */
export async function collectorModules(vendorId: string): Promise<ScriptModules> {
	const hit = memo.get(vendorId);
	if (hit && Date.now() - hit.at < MEMO_MS) return hit.modules;
	const db = dbClient();
	let modules: ScriptModules = { proofs: true };
	if (db) {
		try {
			const { data, error } = await db
				.from("vendors")
				.select("module_proofs")
				.eq("id", vendorId)
				.maybeSingle<{ module_proofs: boolean | null }>();
			if (!error && data) modules = { proofs: data.module_proofs !== false };
		} catch {
			// fail open
		}
	}
	memo.set(vendorId, { at: Date.now(), modules });
	return modules;
}

export async function scriptModules(vendorId: string): Promise<ScriptModules> {
	return collectorModules(vendorId);
}

/** Store the proofs switch. */
export async function setPlainModules(vendorId: string, patch: { proofs?: boolean }): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;
	if (typeof patch.proofs !== "boolean") return true;
	const { error } = await db.from("vendors").update({ module_proofs: patch.proofs }).eq("id", vendorId);
	memo.delete(vendorId);
	return !error;
}

/** Which script asked for the config. Only attest.js remains; `s=visit` from an old visit.js copy is tolerated and ignored. */
export type ScriptName = "visit" | "attest";
export function scriptNameOf(param: string | null): ScriptName {
	return param === "visit" ? "visit" : "attest";
}

const scriptSeen = new Set<string>();

/** Stamp attest.js's first config fetch (proofs_script_seen_at). Once per instance per vendor; only ever sets a null column. */
export async function recordScriptSeen(vendorId: string, script: ScriptName): Promise<void> {
	if (script !== "attest" || scriptSeen.has(vendorId)) return;
	scriptSeen.add(vendorId);
	const db = dbClient();
	if (!db) return;
	try {
		await db.from("vendors").update({ proofs_script_seen_at: new Date().toISOString() }).eq("id", vendorId).is("proofs_script_seen_at", null);
	} catch {
		// Telemetry about installation must never fail config delivery.
	}
}

function iso(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function scriptStatus(vendorId: string): Promise<ScriptStatus | null> {
	const db = dbClient();
	if (!db) return null;
	const { data: vendor } = await db
		.from("vendors")
		.select("slug, domain_verified_at, first_event_at, proofs_script_seen_at")
		.eq("id", vendorId)
		.maybeSingle<{ slug: string; domain_verified_at: string | null; first_event_at: string | null; proofs_script_seen_at: string | null }>();
	if (!vendor) return null;
	const ping = await db.from("config_pings").select("first_seen, last_seen").eq("vendor_slug", vendor.slug).maybeSingle<{ first_seen: string; last_seen: string }>();
	return {
		script_seen_at: iso(ping?.data?.first_seen),
		proofs_script_seen_at: iso(vendor.proofs_script_seen_at),
		last_script_seen_at: iso(ping?.data?.last_seen),
		first_signin_at: iso(vendor.first_event_at),
		domain_verified: Boolean(vendor.domain_verified_at),
	};
}
