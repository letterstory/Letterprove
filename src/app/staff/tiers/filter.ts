/**
 * The ordering and filtering rules behind /staff/tiers, kept out of the
 * component so they can be tested without a DOM (vitest runs this project in
 * `environment: "node"`).
 *
 * All of this is presentational — it changes what a staff member sees first,
 * never what is published. tierReport() remains the source of truth.
 */

import type { DomainTierRow, TierStatus } from "@/lib/tiers/report";

export const STATUS_LABEL: Record<TierStatus, string> = {
	published: "published",
	"consent-withheld": "awaiting consent",
	"no-customer-record": "no customer record",
	"no-observation": "no evidence",
	"not-attributable": "not attributable",
};

/**
 * The two statuses a person can actually move from this page.
 *
 * "not-attributable" is deliberately excluded even though those rows often
 * carry the highest event counts: a free-mail or internal domain can never
 * become a published customer, so it is permanent furniture, not a backlog.
 */
export function isActionable(status: TierStatus): boolean {
	return status === "no-customer-record" || status === "consent-withheld";
}

/**
 * Actionable first, then by volume. The previous order was tierReport()'s own,
 * which is stable but not useful: on lettertrace it put gmail.com (109 events,
 * permanently unpublishable) above the one domain anybody could act on.
 */
const STATUS_RANK: Record<TierStatus, number> = {
	"no-customer-record": 0,
	"consent-withheld": 1,
	published: 2,
	"no-observation": 3,
	"not-attributable": 4,
};

export function eventsOf(row: DomainTierRow): number {
	return row.sessions + row.signups + row.logins;
}

/** Total-ordered, so the list never reshuffles between renders of equal rows. */
export function sortRows(rows: DomainTierRow[]): DomainTierRow[] {
	return [...rows].sort(
		(a, b) =>
			STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
			eventsOf(b) - eventsOf(a) ||
			a.domain.localeCompare(b.domain),
	);
}

/** Case-insensitive match across the three things someone would type. */
export function matchesQuery(row: DomainTierRow, q: string): boolean {
	if (!q) return true;
	return (
		row.domain.toLowerCase().includes(q) ||
		(row.customer?.toLowerCase().includes(q) ?? false) ||
		STATUS_LABEL[row.status].includes(q)
	);
}
