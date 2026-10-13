import { promises as dns } from "node:dns";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkDomainVerification, type TxtResolver, type VerificationOutcome } from "./verification";

/**
 * Domain proof, kept current.
 *
 * verify_domain proves DNS control once. Every tier above 0 rests on that
 * proof ("observed on a domain the vendor proved it controls"), so a proof
 * that is never re-checked turns into a statement about the past: a vendor
 * that deletes the record, lets the domain lapse or sells it would keep
 * publishing as verified indefinitely. The daily cron re-resolves the record
 * for every verified vendor and, after three consecutive misses spanning at
 * least two days, clears `domain_verified_at` — which drops every tier that
 * vendor publishes to 0 at the next freeze, and stops /v1/observe accepting
 * its events, until it verifies again.
 *
 * WHY THREE AND TWO DAYS. DNS changes propagate unevenly and providers have
 * bad hours; a vendor migrating DNS hosts can lose a record briefly without
 * losing control of the domain. One miss proves nothing, three in a row over
 * two days is a record that is gone. Both conditions, so a cron that fires
 * twice in an hour cannot un-verify anyone.
 *
 * A MISS IS DNS ANSWERING WITHOUT THE RECORD. NXDOMAIN or "no data" on the
 * host means the record is not there, and counts. SERVFAIL, timeouts and
 * refused queries mean we could not ask, and do not count: our resolver's bad
 * day must never un-verify a vendor.
 */

export const MISSES_TO_UNVERIFY = 3;
export const MIN_FAILING_MS = 48 * 60 * 60 * 1000;

/** DNS error codes that mean "the name answered: no such record". */
const DEFINITIVE_ABSENCE = new Set(["ENOTFOUND", "ENODATA"]);

/**
 * The live resolver, adjusted so a definitive absence reads as an empty
 * answer rather than a failed lookup. checkDomainVerification treats a
 * thrown lookup as "could not ask", which is right for the first-time verify
 * flow and wrong here: a deleted record must count as missing.
 */
export const recheckResolver: TxtResolver = async (host) => {
	try {
		return await dns.resolveTxt(host);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException)?.code;
		if (code && DEFINITIVE_ABSENCE.has(code)) return [];
		throw e;
	}
};

export interface RecheckState {
	domain_verified_at: string | null;
	domain_dns_failures: number;
	domain_dns_failing_since: string | null;
}

export type RecheckDecision =
	| { kind: "present"; patch: Partial<RecheckState> & { domain_dns_checked_at: string } }
	| { kind: "missed"; patch: Partial<RecheckState> & { domain_dns_checked_at: string }; unverified: boolean }
	| { kind: "unreachable"; patch: { domain_dns_checked_at: string } };

/** Pure: what one re-check does to a vendor's row. */
export function decideRecheck(prev: RecheckState, outcome: VerificationOutcome, now: Date): RecheckDecision {
	const checkedAt = now.toISOString();

	if (outcome.verified) {
		return {
			kind: "present",
			patch: { domain_dns_checked_at: checkedAt, domain_dns_failures: 0, domain_dns_failing_since: null },
		};
	}

	// Could not ask. Leave the run of misses exactly as it was: neither reset
	// it (the record may well be gone) nor extend it (we have no evidence).
	if (outcome.reason === "lookup-failed") {
		return { kind: "unreachable", patch: { domain_dns_checked_at: checkedAt } };
	}

	const failures = prev.domain_dns_failures + 1;
	const failingSince = prev.domain_dns_failing_since ?? checkedAt;
	const unverified =
		failures >= MISSES_TO_UNVERIFY && now.getTime() - new Date(failingSince).getTime() >= MIN_FAILING_MS;

	return {
		kind: "missed",
		unverified,
		patch: {
			domain_dns_checked_at: checkedAt,
			domain_dns_failures: failures,
			domain_dns_failing_since: failingSince,
			...(unverified ? { domain_verified_at: null } : {}),
		},
	};
}

export interface RecheckRunResult {
	ok: boolean;
	checked: number;
	present: number;
	missed: number;
	unreachable: number;
	/** Vendors whose verification this run cleared. */
	unverified: string[];
	/** Per-vendor failures to read or write; the run continues past them. */
	errors: { slug: string; detail: string }[];
	detail?: string;
}

interface VendorRow extends RecheckState {
	id: string;
	slug: string;
	domain: string;
	domain_verification_token: string | null;
}

/** Re-check every DNS-verified vendor. Never throws. */
export async function recheckAllDomains(
	db: SupabaseClient,
	resolver: TxtResolver = recheckResolver,
	now: () => Date = () => new Date(),
): Promise<RecheckRunResult> {
	const result: RecheckRunResult = {
		ok: true,
		checked: 0,
		present: 0,
		missed: 0,
		unreachable: 0,
		unverified: [],
		errors: [],
	};

	const { data, error } = await db
		.from("vendors")
		.select("id, slug, domain, domain_verification_token, domain_verified_at, domain_dns_failures, domain_dns_failing_since")
		.not("domain_verified_at", "is", null)
		.order("slug", { ascending: true });
	if (error) return { ...result, ok: false, detail: `vendor read failed: ${error.message}` };

	for (const vendor of (data ?? []) as VendorRow[]) {
		// A verified vendor without a token cannot be re-checked and is a data
		// fault worth seeing, not a reason to un-verify it.
		if (!vendor.domain_verification_token) {
			result.errors.push({ slug: vendor.slug, detail: "verified but has no verification token" });
			continue;
		}

		let outcome: VerificationOutcome;
		try {
			outcome = await checkDomainVerification(vendor.domain, vendor.domain_verification_token, resolver);
		} catch (e) {
			outcome = { verified: false, reason: "lookup-failed", found: [] };
			result.errors.push({ slug: vendor.slug, detail: e instanceof Error ? e.message : String(e) });
		}

		const decision = decideRecheck(vendor, outcome, now());
		result.checked++;
		result[decision.kind === "present" ? "present" : decision.kind === "missed" ? "missed" : "unreachable"]++;

		// Conditional on the vendor still being verified with the same domain,
		// so a re-verify or a domain change that lands mid-run is never
		// overwritten by a decision made about the old state.
		const { error: writeError } = await db
			.from("vendors")
			.update(decision.patch)
			.eq("id", vendor.id)
			.eq("domain", vendor.domain)
			.not("domain_verified_at", "is", null);
		if (writeError) {
			result.errors.push({ slug: vendor.slug, detail: `write failed: ${writeError.message}` });
			continue;
		}
		if (decision.kind === "missed" && decision.unverified) result.unverified.push(vendor.slug);
	}

	return result;
}
