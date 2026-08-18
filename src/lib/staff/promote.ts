/**
 * Turn an observed domain into a customer record.
 *
 * The gap this closes: lettertrace has been observed for 25 real company
 * domains and has three customer records, all of them `.example` fixtures. So
 * every signed per-customer claim in production is about a company that does
 * not exist, while the evidence about companies that do exist is attached to
 * nothing. The tier report already names each of those domains
 * `no-customer-record`; until now the only way to act on that was a hand-written
 * Supabase insert.
 *
 * What this deliberately does NOT let staff do:
 *
 *   - **Set consent.** A record is always created `anonymous`. Being named is
 *     the customer's decision, evidenced outside this system; a staff member
 *     clicking a button is not that evidence. It contributes to the aggregate
 *     immediately and can be flipped to `named` later, which is the
 *     "build named, ship anonymized, flip as consent lands" order.
 *   - **Set tier or verified.** Those are stored as a ceiling and re-derived
 *     from evidence at publish time by earned(). Letting an operator type a
 *     number here would make the tier an assertion again, which is the thing
 *     the tiers exist to replace.
 *   - **Invent a customer.** Promotion requires the domain to have actually
 *     been observed in the publishing window. A record created for an unobserved
 *     domain is a vendor assertion with extra steps, and it would publish as
 *     tier 0 anyway — but it would also inflate `companies_observed`'s
 *     denominator in the tier report and make the backlog look smaller than it
 *     is.
 *
 * The domain gate is not re-implemented here; classifyDomain is the single
 * authority, so a domain this refuses is refused for exactly the reason the
 * aggregate excluded it.
 */

import { dbClient } from "@/lib/db/client";
import { classifyDomain } from "@/lib/identity/domains";
import { tierReport } from "@/lib/tiers/report";

export type PromoteFailure =
	/** The vendor does not exist, or its telemetry could not be read. */
	| "vendor_unreadable"
	/** free_mail, internal, or malformed — never publishable as a customer. */
	| "not_attributable"
	/** Attributable, but nothing has been observed for it in the window. */
	| "not_observed"
	/** A customer record already maps to this domain. */
	| "already_exists"
	| "storage_unavailable"
	| "write_failed";

export type PromoteResult =
	| { ok: true; slug: string; name: string; domain: string }
	| { ok: false; reason: PromoteFailure; detail: string };

/**
 * Two-part public suffixes, listed rather than guessed.
 *
 * The obvious heuristic — "drop two labels when both are short" — is wrong for
 * a subdomain in front of a short registrable label: `mail.ibm.com` reduces to
 * `mail`, not `ibm`. Short is not the same as suffix.
 *
 * This is deliberately NOT the full Public Suffix List. That is a large,
 * frequently-changing dependency, and the field it would protect is a slug a
 * human is expected to review. An unlisted suffix degrades to dropping one
 * label, which is the same answer the old code gave — never worse. Add entries
 * as real customer domains show you what is missing.
 */
const TWO_PART_SUFFIXES = new Set([
	"com.au", "net.au", "org.au", "edu.au", "co.uk", "org.uk", "ac.uk", "gov.uk",
	"co.nz", "co.za", "co.jp", "ne.jp", "or.jp", "co.kr", "co.in", "co.il",
	"com.br", "com.mx", "com.ar", "com.sg", "com.hk", "com.tw", "com.cn", "com.tr",
]);

/**
 * `acme-corp.example` → `acme-corp`, `mail.ibm.com` → `ibm`. The registrable
 * label only: the TLD is noise in a slug, and two customers differing only by
 * TLD is a naming problem a human should resolve rather than something to
 * silently disambiguate.
 */
export function slugForDomain(domain: string): string {
	const host = domain.trim().toLowerCase().replace(/\.+$/, "");
	const labels = host.split(".").filter(Boolean);

	if (labels.length > 2 && TWO_PART_SUFFIXES.has(labels.slice(-2).join("."))) labels.splice(-2);
	else if (labels.length > 1) labels.pop();

	return (labels.at(-1) ?? host).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A placeholder a human is expected to correct — never presented as researched. */
export function provisionalName(domain: string): string {
	const slug = slugForDomain(domain);
	return slug.split("-").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || domain;
}

export async function promoteDomain(vendorSlug: string, rawDomain: string): Promise<PromoteResult> {
	const domain = rawDomain.trim().toLowerCase().replace(/\.+$/, "");

	const classified = classifyDomain(domain);
	if (classified.kind !== "company") {
		return { ok: false, reason: "not_attributable", detail: classified.reason };
	}

	// Read the report rather than re-querying: it already joins observation to
	// existing records, and going through it means promotion can never disagree
	// with the page the operator is looking at.
	const report = await tierReport(vendorSlug);
	if (!report) {
		return { ok: false, reason: "vendor_unreadable", detail: `no readable report for "${vendorSlug}"` };
	}

	const row = report.rows.find((r) => r.domain === domain);
	if (!row || row.sessions + row.signups + row.logins === 0) {
		return {
			ok: false,
			reason: "not_observed",
			detail: `nothing observed for "${domain}" in the publishing window`,
		};
	}
	if (row.customer) {
		return { ok: false, reason: "already_exists", detail: `already recorded as "${row.customer}"` };
	}

	const db = dbClient();
	if (!db) return { ok: false, reason: "storage_unavailable", detail: "no datastore configured" };

	const { data: vendor } = await db.from("vendors").select("id").eq("slug", vendorSlug).maybeSingle();
	if (!vendor) return { ok: false, reason: "vendor_unreadable", detail: `no vendor "${vendorSlug}"` };

	const slug = slugForDomain(domain);
	const name = provisionalName(domain);

	const { error } = await db.from("vendor_customers").insert({
		vendor_id: vendor.id,
		slug,
		name,
		domain,
		// The window we can actually stand behind. We know when we first saw
		// them, not when they became a customer, and inventing an earlier date
		// would be the first false thing in the record.
		since: new Date().toISOString().slice(0, 10),
		// Script-observed. A ceiling, not a grant — earned() re-derives what the
		// evidence supports every time the claim is built.
		tier: 1,
		verified: false,
		features: [],
		consent: "anonymous",
	});

	if (error) {
		// Unique (vendor_id, slug): two domains reduced to the same label.
		if (error.code === "23505") {
			return { ok: false, reason: "already_exists", detail: `slug "${slug}" is already taken for this vendor` };
		}
		return { ok: false, reason: "write_failed", detail: error.message };
	}

	return { ok: true, slug, name, domain };
}
