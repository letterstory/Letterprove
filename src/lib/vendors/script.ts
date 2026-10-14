/**
 * One script per vendor, three modules (Matthew's "Scripts" IA):
 *
 *   proofs          sign-ins observed by attest.js — the proof's evidence
 *   agent_visitors  AI agents and crawlers reading the vendor's site
 *   human_visitors  people and companies identified by Maverick
 *
 * The script tag is the same whichever are on; /v1/config tells attest.js
 * which to run, and the collectors drop what a vendor turned off (the config
 * is CDN-cached for minutes, so the server side is what makes "off" final).
 * human_visitors is the existing visitor identification switch
 * (src/lib/vendors/visitors.ts), so it keeps that module's DNS requirement and
 * Maverick registration.
 */

import { dbClient } from "@/lib/db/client";
import { visitorIdentificationStatus } from "@/lib/vendors/visitors";

export interface ScriptModules {
	proofs: boolean;
	agent_visitors: boolean;
	human_visitors: boolean;
}

export interface ScriptStatus {
	script_seen_at: string | null;
	visitors_script_seen_at: string | null;
	proofs_script_seen_at: string | null;
	last_script_seen_at: string | null;
	server_seen_at: string | null;
	first_agent_visit_at: string | null;
	first_signin_at: string | null;
	domain_verified: boolean;
	site_verified_at: string | null;
}

const MEMO_MS = 60_000;
const memo = new Map<string, { at: number; modules: Pick<ScriptModules, "proofs" | "agent_visitors"> }>();

/** Test seam. */
export function _resetModuleMemo(): void {
	memo.clear();
	serverSeen.clear();
	scriptSeen.clear();
}

/**
 * The collector-side read: whether sign-ins and agent beacons are on. Memoized
 * per instance for a minute because every event asks. Fails open to the
 * defaults (both on): a read failure must not silently stop a vendor's proof.
 */
export async function collectorModules(vendorId: string): Promise<Pick<ScriptModules, "proofs" | "agent_visitors">> {
	const hit = memo.get(vendorId);
	if (hit && Date.now() - hit.at < MEMO_MS) return hit.modules;
	const db = dbClient();
	let modules = { proofs: true, agent_visitors: true };
	if (db) {
		try {
			const { data, error } = await db
				.from("vendors")
				.select("module_proofs, module_agent_visitors")
				.eq("id", vendorId)
				.maybeSingle<{ module_proofs: boolean | null; module_agent_visitors: boolean | null }>();
			if (!error && data) modules = { proofs: data.module_proofs !== false, agent_visitors: data.module_agent_visitors !== false };
		} catch {
			// defaults
		}
	}
	memo.set(vendorId, { at: Date.now(), modules });
	return modules;
}

export async function scriptModules(vendorId: string): Promise<ScriptModules> {
	memo.delete(vendorId);
	const [base, visitors] = await Promise.all([collectorModules(vendorId), visitorIdentificationStatus(vendorId)]);
	return { ...base, human_visitors: Boolean(visitors?.enabled) };
}

/** Store the two plain switches. human_visitors goes through setVisitorIdentification. */
export async function setPlainModules(vendorId: string, patch: { proofs?: boolean; agent_visitors?: boolean }): Promise<boolean> {
	const db = dbClient();
	if (!db) return false;
	const update: Record<string, boolean> = {};
	if (typeof patch.proofs === "boolean") update.module_proofs = patch.proofs;
	if (typeof patch.agent_visitors === "boolean") update.module_agent_visitors = patch.agent_visitors;
	if (Object.keys(update).length === 0) return true;
	const { error } = await db.from("vendors").update(update).eq("id", vendorId);
	memo.delete(vendorId);
	return !error;
}

const serverSeen = new Set<string>();

/**
 * Stamp the first request the vendor's server snippet forwarded, whatever it
 * was. Once per instance per vendor after it lands, and only ever sets a null
 * column, so the busiest vendor costs one write per cold instance.
 */
export async function recordServerSeen(vendorId: string): Promise<void> {
	if (serverSeen.has(vendorId)) return;
	serverSeen.add(vendorId);
	const db = dbClient();
	if (!db) return;
	try {
		await db.from("vendors").update({ server_seen_at: new Date().toISOString() }).eq("id", vendorId).is("server_seen_at", null);
	} catch {
		// Telemetry about installation must never fail a forward.
	}
}

/** Which script asked for the config: `s=visit` is visit.js, anything else (including no `s`, an attest.js from before the split) is attest.js. */
export type ScriptName = "visit" | "attest";
export function scriptNameOf(param: string | null): ScriptName {
	return param === "visit" ? "visit" : "attest";
}

const scriptSeen = new Set<string>();

/**
 * Stamp the first config fetch from each script (visitors_script_seen_at /
 * proofs_script_seen_at). Like recordServerSeen: once per instance per vendor
 * per script, and only ever sets a null column.
 */
export async function recordScriptSeen(vendorId: string, script: ScriptName): Promise<void> {
	const memoKey = `${vendorId}:${script}`;
	if (scriptSeen.has(memoKey)) return;
	scriptSeen.add(memoKey);
	const db = dbClient();
	if (!db) return;
	const column = script === "visit" ? "visitors_script_seen_at" : "proofs_script_seen_at";
	try {
		await db.from("vendors").update({ [column]: new Date().toISOString() }).eq("id", vendorId).is(column, null);
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
		.select("slug, domain_verified_at, site_verified_at, server_seen_at, first_event_at, visitors_script_seen_at, proofs_script_seen_at")
		.eq("id", vendorId)
		.maybeSingle<{
			slug: string;
			domain_verified_at: string | null;
			site_verified_at: string | null;
			server_seen_at: string | null;
			first_event_at: string | null;
			visitors_script_seen_at: string | null;
			proofs_script_seen_at: string | null;
		}>();
	if (!vendor) return null;
	const [ping, firstVisit] = await Promise.all([
		db.from("config_pings").select("first_seen, last_seen").eq("vendor_slug", vendor.slug).maybeSingle<{ first_seen: string; last_seen: string }>(),
		db
			.from("vendor_agent_visits")
			.select("first_at")
			.eq("vendor_id", vendorId)
			.order("first_at", { ascending: true })
			.limit(1)
			.maybeSingle<{ first_at: string }>(),
	]);
	return {
		script_seen_at: iso(ping?.data?.first_seen),
		visitors_script_seen_at: iso(vendor.visitors_script_seen_at),
		proofs_script_seen_at: iso(vendor.proofs_script_seen_at),
		last_script_seen_at: iso(ping?.data?.last_seen),
		server_seen_at: iso(vendor.server_seen_at),
		first_agent_visit_at: iso(firstVisit?.data?.first_at),
		first_signin_at: iso(vendor.first_event_at),
		domain_verified: Boolean(vendor.domain_verified_at),
		site_verified_at: iso(vendor.site_verified_at),
	};
}
