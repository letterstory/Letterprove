import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DISPLAY, hiddenSections, normalizeDisplay } from "./display";
import { logoSplit, payingSentence } from "./paying-copy";

vi.mock("@/lib/db/client", () => ({ dbClient: vi.fn(() => null) }));

describe("display settings", () => {
	it("hides the paying count and names logos by default", () => {
		expect(DEFAULT_DISPLAY.paying_count).toBe("hidden");
		expect(DEFAULT_DISPLAY.logo_names).toBe(true);
		expect(normalizeDisplay(undefined)).toEqual(DEFAULT_DISPLAY);
	});

	it("accepts only the known paying_count values", () => {
		expect(normalizeDisplay({ paying_count: "all" }).paying_count).toBe("all");
		expect(normalizeDisplay({ paying_count: "signed_in" }).paying_count).toBe("signed_in");
		expect(normalizeDisplay({ paying_count: "everyone" }).paying_count).toBe("hidden");
		expect(normalizeDisplay({ logo_names: "no" }).logo_names).toBe(true);
		expect(normalizeDisplay({ logo_names: false }).logo_names).toBe(false);
	});

	it("never reports paying_count or logo_names as hidden sections", () => {
		const hidden = hiddenSections({ ...DEFAULT_DISPLAY, paying_count: "hidden", logo_names: false, sessions: false });
		expect(hidden).toEqual(["sessions"]);
	});
});

describe("set_proof_display", () => {
	it("refuses an unknown paying_count before touching storage", async () => {
		const { dispatchTool } = await import("@/lib/tools/registry");
		const principal = { tokenId: "t", vendorId: "v1", userId: "u", capabilities: ["vendor:read", "vendor:write"] } as never;
		const o = await dispatchTool("set_proof_display", { sections: { paying_count: "everyone" } }, principal);
		expect(o).toMatchObject({ kind: "result", result: { ok: false, status: 400, body: { error: "invalid_sections" } } });
	});
});

describe("copy", () => {
	it("says which paying count it is", () => {
		expect(payingSentence({ scope: "signed_in", companies: 44 })).toBe("44 companies signed in and paid through Stripe (last 30 days)");
		expect(payingSentence({ scope: "all", companies: 1200 })).toBe("1,200 companies paid through Stripe");
	});

	it("splits logos from counts, or from names on older snapshots", () => {
		expect(logoSplit({ paying: 38, active: 5 })).toEqual({ paying: 38, active: 5 });
		expect(logoSplit({ companies: [{ status: "paying" }, { status: "active" }, { status: "paying" }] })).toEqual({ paying: 2, active: 1 });
	});
});
