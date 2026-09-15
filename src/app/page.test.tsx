import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/fixtures/vendors", () => ({ publishedVendors: vi.fn() }));
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

async function render(host: string | null, slugs: string[] = ["vantage", "lettertrace"]) {
	const { headers } = await import("next/headers");
	const { publishedVendors } = await import("@/lib/fixtures/vendors");
	vi.mocked(headers).mockResolvedValue(new Headers(host ? { host } : {}) as never);
	vi.mocked(publishedVendors).mockResolvedValue(
		slugs.map((slug) => ({ slug, name: slug, domain: `${slug}.com`, category: "c", key: "k", customers: [] })) as never
	);
	const { default: Home } = await import("./page");
	return textOf(await Home());
}

beforeEach(() => vi.resetModules());

describe("the homepage's verify command", () => {
	/**
	 * It read `http://localhost:9100/...` in production for as long as the page
	 * existed. "Verify it yourself" is this product's entire pitch, and a visitor
	 * who followed it got connection refused — the copy-paste equivalent of the
	 * cdn.letterprove.com install snippet.
	 */
	it("never tells a visitor to curl localhost", async () => {
		const text = await render("app.letterprove.com");
		expect(text).not.toMatch(/localhost/);
	});

	it("points at the deployment the visitor is reading", async () => {
		expect(await render("app.letterprove.com")).toContain("https://app.letterprove.com/attest/");
	});

	// A developer reading the page on their own machine should get a command
	// that works on their own machine.
	it("follows a local deployment when served from one", async () => {
		expect(await render("localhost:9100")).toContain("http://localhost:9100/attest/");
	});

	/**
	 * A chain, not a single document: verifying one attestation checks a
	 * signature, verifying the chain checks every prev_hash link too — which is
	 * the claim the product actually makes.
	 */
	it("demonstrates the chain rather than one document", async () => {
		expect(await render("app.letterprove.com")).toMatch(/\/attest\/\w+\/chain/);
	});

	/**
	 * acme-corp is a fixture: a company that does not exist, publishing tier 0
	 * because the evidence gate correctly refuses to promote it. It was the least
	 * convincing thing on offer.
	 */
	it("does not demo the fixture customer", async () => {
		expect(await render("app.letterprove.com")).not.toMatch(/acme-corp/);
	});

	it("falls back to the canonical host when nothing identifies the deployment", async () => {
		expect(await render(null)).toContain("https://app.letterprove.com/attest/");
	});

	it("still renders something verifiable with no vendors at all", async () => {
		const text = await render("app.letterprove.com", []);
		expect(text).toContain("https://app.letterprove.com/.well-known/letterprove.json");
	});
});
