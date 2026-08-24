import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TIER_LADDER, tierLadderDocument } from "./tiers";

/**
 * The verifier keeps its OWN copy of the tier names, on purpose:
 * scripts/verify.mjs shares no code with the service, so that a disagreement
 * between the producer and the spec is detectable rather than impossible.
 * Importing this module there would destroy that property.
 *
 * The cost of independence is drift. This test pays it by reading verify.mjs
 * as TEXT and comparing the vocabulary — no import, no coupling, but renaming
 * a tier on one side and not the other fails here instead of in front of an
 * agent that got two different answers from two of our own surfaces.
 */
function verifierTierNames(): Record<string, string> {
	const source = readFileSync(join(process.cwd(), "scripts/verify.mjs"), "utf8");
	const block = source.match(/const TIERS = \{([\s\S]*?)\};/);
	if (!block) throw new Error("scripts/verify.mjs no longer declares a TIERS map — update this test");

	const names: Record<string, string> = {};
	for (const [, tier, name] of block[1].matchAll(/(\d+):\s*"([^"]+)"/g)) names[tier] = name;
	return names;
}

describe("the published tier ladder", () => {
	it("uses exactly the vocabulary the independent verifier reports", () => {
		const fromVerifier = verifierTierNames();
		const published = Object.fromEntries(Object.entries(TIER_LADDER).map(([t, d]) => [t, d.name]));

		expect(published).toEqual(fromVerifier);
	});

	it("covers every tier the type allows, with no gaps", () => {
		expect(Object.keys(TIER_LADDER).map(Number).sort()).toEqual([0, 1, 2, 3, 4]);
	});

	it("says who could forge each tier, which is the part an agent actually needs", () => {
		for (const [tier, d] of Object.entries(TIER_LADDER)) {
			expect(d.forgeable_by.length, `tier ${tier} must say who could fake it`).toBeGreaterThan(20);
			expect(d.means.length, `tier ${tier} must say what it means`).toBeGreaterThan(20);
		}
	});

	/*
	 * The misreading this whole module exists to prevent: a valid signature
	 * over a tier-0 body proving only that the vendor said so. If the published
	 * note ever stops making that explicit, an agent verifying cryptography
	 * correctly can still conclude "attested" about nothing.
	 */
	it("states plainly that a valid signature is not itself the claim", () => {
		const { note } = tierLadderDocument();
		expect(note).toMatch(/signature/i);
		expect(note).toMatch(/tier/i);
		expect(note.toLowerCase()).toContain("tier-0");
	});

	it("publishes levels in ascending order, so weakest-first reads correctly", () => {
		const tiers = tierLadderDocument().levels.map((l) => l.tier);
		expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
	});

	it("describes tier 4 as reaching the customer's own domain, not the vendor", () => {
		// Guards the delivery binding's description against quietly softening
		// back to "the vendor sends a link", which is what it used to be.
		expect(TIER_LADDER[4].means).toMatch(/their own domain/i);
		expect(TIER_LADDER[4].means).toMatch(/vendor never held/i);
	});
});
