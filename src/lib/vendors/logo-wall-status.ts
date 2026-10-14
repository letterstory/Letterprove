/**
 * The one answer every logo-wall tool gives the vendor: every company they
 * listed, whether it was found on their page, its status from Letterprove's
 * own evidence, and whether the block is on the proof right now.
 *
 * Private to the vendor, so it includes the companies that are NOT verified
 * too. Only the attestation's `logos` block is public (see logo-wall.ts).
 */

import { findVendor } from "@/lib/fixtures/vendors";
import { tierReport } from "@/lib/tiers/report";
import { MAX_CHECK_AGE_MS, readLogoWall, statusOf, type LogoStatus } from "./logo-wall";

export interface LogoWallStatus {
	configured: true;
	page_url: string;
	checked_at: string | null;
	check_error: string | null;
	total: number;
	on_page: number;
	verified: number;
	published: boolean;
	companies: { name: string; domain: string; on_page: boolean; status: LogoStatus }[];
}

export async function logoWallStatus(vendorId: string, vendorSlug: string): Promise<LogoWallStatus | null> {
	const wall = await readLogoWall(vendorId);
	if (!wall) return null;
	const vendor = await findVendor(vendorSlug);
	const report = await tierReport(vendorSlug);
	const observed = new Set<string>();
	for (const row of report?.rows ?? []) {
		if (row.status === "observed") observed.add(row.domain);
	}
	const companies = wall.companies.map((c) => ({ ...c, status: statusOf(c.domain, observed) }));
	const fresh = wall.checked_at !== null && Date.now() - Date.parse(wall.checked_at) <= MAX_CHECK_AGE_MS;
	return {
		configured: true,
		page_url: wall.page_url,
		checked_at: wall.checked_at,
		check_error: wall.check_error,
		total: companies.length,
		on_page: companies.filter((c) => c.on_page).length,
		verified: companies.filter((c) => c.on_page && c.status !== "not_observed").length,
		published: fresh && Boolean(vendor?.domainVerified),
		companies,
	};
}
