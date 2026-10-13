/**
 * The words every surface uses for the two vendor-configurable figures
 * (src/lib/attest/display.ts): the opt-in paying count and the logo split.
 * One place, so the proof page, the verify page, llms.txt and JSON-LD can't
 * describe the same number differently.
 */

export interface PayingFigure {
	scope: "signed_in" | "all";
	companies: number;
}

/** "{n} companies signed in and paid through Stripe (last 30 days)" / "{n} companies paid through Stripe". */
export function payingSentence(p: PayingFigure): string {
	const n = p.companies.toLocaleString("en-US");
	return p.scope === "signed_in" ? `${n} companies signed in and paid through Stripe (last 30 days)` : `${n} companies paid through Stripe`;
}

interface LogoBlockLike {
	paying?: number;
	active?: number;
	companies?: { status: string }[];
}

/**
 * Paying / active counts of a logos block. Snapshots signed before the counts
 * were added carry only the named companies, so fall back to counting those.
 */
export function logoSplit(logos: LogoBlockLike): { paying: number; active: number } {
	const companies = logos.companies ?? [];
	return {
		paying: typeof logos.paying === "number" ? logos.paying : companies.filter((c) => c.status === "paying").length,
		active: typeof logos.active === "number" ? logos.active : companies.filter((c) => c.status === "active").length,
	};
}
