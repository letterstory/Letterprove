import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DISPLAY, DISPLAY_SECTIONS, hiddenSections, normalizeDisplay } from "./display";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn(() => null) }));

describe("display settings", () => {
	it("shows everything and names logos by default", () => {
		expect(DEFAULT_DISPLAY.logo_names).toBe(true);
		expect(DEFAULT_DISPLAY.stripe_business).toBe(true);
		expect(normalizeDisplay(undefined)).toEqual(DEFAULT_DISPLAY);
	});

	it("has no payment setting any more, and ignores retired ones that are still stored", () => {
		expect(DISPLAY_SECTIONS).not.toContain("payment_details");
		expect(DEFAULT_DISPLAY).not.toHaveProperty("paying_count");
		const n = normalizeDisplay({ paying_count: "all", payment_details: false, logo_names: false });
		expect(n).not.toHaveProperty("paying_count");
		expect(n).not.toHaveProperty("payment_details");
		expect(n.logo_names).toBe(false);
		expect(normalizeDisplay({ logo_names: "no" }).logo_names).toBe(true);
	});

	it("never reports logo_names as a hidden section", () => {
		expect(hiddenSections({ ...DEFAULT_DISPLAY, logo_names: false, sessions: false })).toEqual(["sessions"]);
	});
});

describe("set_proof_display", () => {
	it("refuses a non-boolean section before touching storage", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const principal = { tokenId: "t", vendorId: "v1", userId: "u", capabilities: ["vendor:read", "vendor:write"] } as never;
		const o = await dispatchTool("set_proof_display", { sections: { sessions: "yes" } }, principal);
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 400, body: { error: "invalid_sections" } } });
	});
});
