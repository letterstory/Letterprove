import { describe, expect, it } from "vitest";
import { applyToReadme } from "./gen-readme-status.mjs";

describe("README build-status block", () => {
	it("matches what the checks find in the current source", () => {
		// Fails the moment someone ships a status-relevant change (fixes the
		// token default, wires ASN capture, adds Stripe) without re-running
		// `node scripts/gen-readme-status.mjs` — the same drift that let
		// "collection not started" survive collection actually shipping.
		expect(applyToReadme(/* check */ true)).toBe(true);
	});
});
