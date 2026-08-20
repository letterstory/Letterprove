import { randomBytes } from "node:crypto";

/**
 * Same family as the seeded fixtures ("lp_live_vantage_9f2c",
 * "lp_live_lettertrace_5747b5e0f521"): prefix + slug + short hex, no fixed
 * length requirement. Shared by onboarding (mints the first key) and the
 * rotate_key tool (mints a replacement) so the format can't drift between them.
 */
export function generateKey(slug: string): string {
	return `lp_live_${slug}_${randomBytes(6).toString("hex")}`;
}
