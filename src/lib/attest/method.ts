/**
 * The `method` link every attestation carries.
 *
 * Open computation is the trust mechanism, not housekeeping: an agent that can
 * read the code which produced a number is in a categorically better position
 * than one that can only check a signature. That only holds if the link is
 * pinned to a COMMIT — a branch link describes today's logic, not the logic
 * that computed a snapshot published in March.
 */

const REPO = "https://github.com/letterstory/Letterprove";

/** Vercel exposes the deployed SHA; locally we fall back to an unpinned link. */
function commit(): string {
	return process.env.LETTERPROVE_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "main";
}

/** @param path repo-relative path of the logic that computed the claim */
export function methodUrl(path: string): string {
	return `${REPO}/blob/${commit()}/${path}`;
}
