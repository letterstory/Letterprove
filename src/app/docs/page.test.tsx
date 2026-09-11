import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIER_LADDER } from "@/lib/attest/tiers";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
// Chrome and Link render nothing useful here and drag in client-only concerns.
vi.mock("@/components/chrome", () => ({
	DevKeyBanner: () => null,
	SiteFooter: () => null,
	SiteHeader: () => null,
}));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));

/** Walks the returned element tree and collects every string in it. */
function textOf(node: unknown): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	const el = node as { props?: { children?: unknown } };
	return el.props ? textOf(el.props.children) : "";
}

async function render(host: string | null) {
	const { headers } = await import("next/headers");
	vi.mocked(headers).mockResolvedValue(new Headers(host ? { host } : {}) as never);
	const { default: Docs } = await import("./page");
	return textOf(await Docs());
}

beforeEach(() => vi.resetModules());

describe("the docs page", () => {
	/**
	 * Same failure the homepage already had, and worse here: this page is where
	 * a vendor copies their install snippet and a sceptic copies a verify
	 * command. A written-down host is what broke collection twice already (see
	 * src/lib/vendors/install.ts).
	 */
	it("never tells a reader on production to fetch localhost", async () => {
		expect(await render("app.letterprove.com")).not.toMatch(/localhost/);
	});

	it("builds the install snippet against the deployment being read", async () => {
		const text = await render("app.letterprove.com");
		expect(text).toContain('<script src="https://app.letterprove.com/attest.js"');
	});

	it("follows a local deployment when served from one", async () => {
		expect(await render("localhost:9100")).toContain("http://localhost:9100/attest.js");
	});

	it("falls back to the canonical host when nothing identifies the deployment", async () => {
		expect(await render(null)).toContain("https://app.letterprove.com/attest.js");
	});

	/**
	 * The verify instructions are the point of the page, and a chain is what
	 * makes them worth following: a single document's prev_hash has nothing to
	 * be checked against.
	 */
	it("teaches the chain, and where the keys come from", async () => {
		const text = await render("app.letterprove.com");
		expect(text).toMatch(/\/attest\/<vendor>\/chain/);
		expect(text).toContain("/.well-known/letterprove-jwks.json");
		expect(text).toMatch(/verify\.mjs|npm run verify/);
	});

	/**
	 * Rendered from TIER_LADDER rather than retyped, so adding a tier cannot
	 * leave documentation describing a ladder we no longer publish. This test is
	 * what makes that guarantee cost something to break.
	 */
	it("describes every tier the service actually publishes", async () => {
		const text = await render("app.letterprove.com");
		for (const [tier, description] of Object.entries(TIER_LADDER)) {
			// Whitespace-tolerant: textOf joins sibling nodes with a space, and the
			// label and the number are separate nodes.
			expect(text).toMatch(new RegExp(`tier\\s+${tier}`));
			expect(text).toContain(description.name);
			expect(text).toContain(description.forgeable_by);
		}
	});

	/**
	 * The three things a vendor would most like left out. A docs page that reads
	 * better than the system behaves is the one failure this product cannot
	 * afford, so each is asserted rather than trusted to survive an edit.
	 */
	it("keeps the unflattering facts", async () => {
		const text = await render("app.letterprove.com");
		// seats_active is signed as a literal 0 for everyone (src/rollup/snapshots.ts).
		expect(text).toMatch(/seats_active[\s\S]{0,40}always 0/);
		// Tier 3 has never run against a live-mode Stripe key (README § Open).
		expect(text).toMatch(/never run against a live-mode Stripe key/);
		// A valid signature is not the claim; the tier is.
		expect(text).toMatch(/tier-0 body asserts only that the vendor said so/);
	});
});
