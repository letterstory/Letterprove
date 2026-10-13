import type { SupabaseClient } from "@supabase/supabase-js";
import { dbClient } from "@/lib/db/client";
import { normalizeDomain } from "@/lib/vendors/domain";
import { registrableDomain } from "@/lib/vendors/custom-domain";
import { checkDomainVerification, expectedRecord, verificationHosts, type TxtResolver } from "./verification";
import { decideRecheck, recheckResolver, type RecheckState } from "./dns-recheck";

/**
 * Extra hosts a vendor collects from, beyond its verified `domain`.
 *
 * /v1/observe pins every event to an origin, and until now the only origin it
 * accepted was `vendor.domain`. A company that signs people in on app.acme.com
 * and www.acme.com collected from one and silently dropped the other. This
 * lets a vendor name the other hosts — but only ones its DNS proof actually
 * covers, because "observed on a domain the vendor proved it controls" is the
 * sentence every tier above 0 rests on.
 *
 * THE TRUST RULE.
 *
 * - A host UNDER the verified domain (verified acme.com, host app.acme.com; or
 *   verified app.acme.com, host eu.app.acme.com) is covered by the same proof.
 *   Whoever can publish a TXT record on a name controls the DNS of the names
 *   beneath it. Accepted at once, for as long as the vendor stays verified.
 *
 * - Any other host sharing the registrable domain (verified app.acme.com, host
 *   eu.app.acme.com is covered, but eu.acme.com, www.acme.com and acme.com are
 *   siblings or parents) is NOT proven by a record on app.acme.com: a team that
 *   controls one subdomain need not control its siblings. Such a host needs the
 *   vendor's own verification record on that host (or on the registrable
 *   domain, which covers everything under it), and is re-checked daily like
 *   the vendor's domain.
 *
 * - A host on a different registrable domain is refused outright. One vendor,
 *   one company; a second company's site is a second vendor.
 */

export type HostProof = "under_verified_domain" | "own_dns";

export interface HostRow {
	host: string;
	proof: HostProof;
	verified_at: string | null;
	created_at: string;
}

/** Hosts a vendor may add at most. Generous; the limit exists to bound the observe lookup. */
export const MAX_HOSTS = 20;

export type HostCheck =
	| { ok: true; host: string; proof: HostProof }
	| { ok: false; error: "invalid_host" | "same_as_domain" | "domain_not_yours"; detail: string };

/** Whether `host` sits strictly below `domain` in the DNS tree. */
function isUnder(host: string, domain: string): boolean {
	return host.endsWith(`.${domain}`);
}

/** Pure: which proof a host needs, or why it can't be one of this vendor's hosts. */
export function classifyHost(input: string, vendorDomain: string): HostCheck {
	const host = normalizeDomain(input);
	if (!host || host === "localhost" || host.includes(":")) {
		return { ok: false, error: "invalid_host", detail: `"${input}" isn't a hostname. Use something like app.yourcompany.com.` };
	}
	if (host === vendorDomain) {
		return { ok: false, error: "same_as_domain", detail: `${host} is already your verified domain; events from it are accepted.` };
	}
	const base = registrableDomain(vendorDomain);
	if (registrableDomain(host) !== base) {
		return {
			ok: false,
			error: "domain_not_yours",
			detail: `Hosts must be on ${base}, the domain you verified. A different company's site needs its own vendor.`,
		};
	}
	return { ok: true, host, proof: isUnder(host, vendorDomain) ? "under_verified_domain" : "own_dns" };
}

/** Where a host needing its own proof may carry the record: the host itself, or the registrable domain. */
export function hostVerificationHosts(host: string): string[] {
	const base = registrableDomain(host);
	return [...verificationHosts(host), ...(base === host ? [] : verificationHosts(base))];
}

/** Check a host's own DNS proof: the vendor's record on the host or on the registrable domain. */
export async function checkHostVerification(host: string, token: string, resolver?: TxtResolver) {
	const direct = await checkDomainVerification(host, token, resolver);
	if (direct.verified) return direct;
	const base = registrableDomain(host);
	if (base === host) return direct;
	const parent = await checkDomainVerification(base, token, resolver);
	if (parent.verified) return parent;
	// Report the more informative miss: any record seen beats a failed lookup.
	if (direct.reason === "lookup-failed") return parent;
	return direct;
}

/** The status every host tool answers with. */
export function hostStatus(row: HostRow, token: string | null) {
	const accepted = row.proof === "under_verified_domain" || row.verified_at !== null;
	return {
		host: row.host,
		proof: row.proof,
		accepted,
		verified_at: row.verified_at,
		added_at: row.created_at,
		record: !accepted && token ? expectedRecord(token) : null,
		record_hosts: !accepted ? hostVerificationHosts(row.host) : [],
		message: accepted
			? row.proof === "under_verified_domain"
				? `Events from ${row.host} are accepted: it sits under the domain you verified.`
				: `Events from ${row.host} are accepted: its own DNS record checks out.`
			: `${row.host} isn't under the domain you verified, so it needs its own proof. Add the TXT record below at _letterprove.${row.host} (or on ${registrableDomain(row.host)}), then run add_host again to check.`,
	};
}

/**
 * The hosts /v1/observe accepts for a vendor besides its domain. Cached per
 * instance for a minute: observe runs on every event, and a vendor's host list
 * changes about never.
 */
const acceptedCache = new Map<string, { hosts: Set<string>; at: number }>();
const ACCEPTED_TTL_MS = 60_000;

export async function acceptedHosts(vendorId: string): Promise<Set<string>> {
	const hit = acceptedCache.get(vendorId);
	if (hit && Date.now() - hit.at < ACCEPTED_TTL_MS) return hit.hosts;
	const db = dbClient();
	if (!db) return new Set();
	const { data } = await db.from("vendor_hosts").select("host, proof, verified_at").eq("vendor_id", vendorId);
	const hosts = new Set(
		((data ?? []) as Pick<HostRow, "host" | "proof" | "verified_at">[])
			.filter((r) => r.proof === "under_verified_domain" || r.verified_at !== null)
			.map((r) => r.host),
	);
	acceptedCache.set(vendorId, { hosts, at: Date.now() });
	return hosts;
}

/** Drop the cached list, after a write in this instance. */
export function forgetAcceptedHosts(vendorId: string): void {
	acceptedCache.delete(vendorId);
}

// ---------------------------------------------------------------- daily re-check

interface HostRecheckRow {
	vendor_id: string;
	host: string;
	verified_at: string | null;
	dns_failures: number;
	dns_failing_since: string | null;
}

/**
 * Re-check every own-DNS host, with the vendor-domain rule: three definitive
 * misses over at least two days clear `verified_at`; a resolver that can't be
 * reached never counts. Hosts under the verified domain have nothing of their
 * own to re-check — they lapse with the vendor's domain.
 */
export async function recheckOwnDnsHosts(
	db: SupabaseClient,
	resolver: TxtResolver = recheckResolver,
	now: () => Date = () => new Date(),
): Promise<{ checked: number; unverified: string[]; errors: { host: string; detail: string }[] }> {
	const out = { checked: 0, unverified: [] as string[], errors: [] as { host: string; detail: string }[] };
	const { data, error } = await db
		.from("vendor_hosts")
		.select("vendor_id, host, verified_at, dns_failures, dns_failing_since")
		.eq("proof", "own_dns");
	if (error) {
		out.errors.push({ host: "*", detail: `host read failed: ${error.message}` });
		return out;
	}
	// Only hosts that are currently accepted; one still waiting on its first
	// record has nothing to lose.
	const rows = ((data ?? []) as HostRecheckRow[]).filter((r) => r.verified_at !== null);
	const vendorIds = [...new Set(rows.map((r) => r.vendor_id))];
	const vendors = new Map<string, { slug: string; domain_verification_token: string | null }>();
	if (vendorIds.length > 0) {
		const { data: vrows } = await db.from("vendors").select("id, slug, domain_verification_token").in("id", vendorIds);
		for (const v of (vrows ?? []) as { id: string; slug: string; domain_verification_token: string | null }[]) vendors.set(v.id, v);
	}
	for (const row of rows) {
		const vendor = vendors.get(row.vendor_id);
		const token = vendor?.domain_verification_token;
		if (!token) {
			out.errors.push({ host: row.host, detail: "vendor has no verification token" });
			continue;
		}
		let outcome;
		try {
			outcome = await checkHostVerification(row.host, token, resolver);
		} catch (e) {
			outcome = { verified: false as const, reason: "lookup-failed" as const, found: [] };
			out.errors.push({ host: row.host, detail: e instanceof Error ? e.message : String(e) });
		}
		const prev: RecheckState = {
			domain_verified_at: row.verified_at,
			domain_dns_failures: row.dns_failures,
			domain_dns_failing_since: row.dns_failing_since,
		};
		const decision = decideRecheck(prev, outcome, now());
		out.checked++;
		const patch: Record<string, unknown> = { dns_checked_at: decision.patch.domain_dns_checked_at };
		if ("domain_dns_failures" in decision.patch) patch.dns_failures = decision.patch.domain_dns_failures;
		if ("domain_dns_failing_since" in decision.patch) patch.dns_failing_since = decision.patch.domain_dns_failing_since;
		if (decision.kind === "missed" && decision.unverified) patch.verified_at = null;
		const { error: writeError } = await db
			.from("vendor_hosts")
			.update(patch)
			.eq("vendor_id", row.vendor_id)
			.eq("host", row.host)
			.eq("proof", "own_dns");
		if (writeError) {
			out.errors.push({ host: row.host, detail: `write failed: ${writeError.message}` });
			continue;
		}
		if (decision.kind === "missed" && decision.unverified) out.unverified.push(`${vendor?.slug}:${row.host}`);
	}
	return out;
}
