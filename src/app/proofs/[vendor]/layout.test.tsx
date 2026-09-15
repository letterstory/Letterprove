import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fixtures/vendors", () => ({ findPublishedVendor: vi.fn() }));
vi.mock("next/navigation", () => ({
	notFound: vi.fn(() => {
		// Real notFound() throws a routing signal; throwing here lets the test
		// assert the layout actually aborts rather than rendering children.
		throw new Error("NEXT_NOT_FOUND");
	}),
}));

import ProofLayout from "./layout";
import { findPublishedVendor } from "@/lib/fixtures/vendors";
import { notFound } from "next/navigation";

beforeEach(() => vi.clearAllMocks());

/**
 * The status-code guard for `/proofs/{vendor}`.
 *
 * `page.tsx` also calls notFound(), but from inside the loading.tsx Suspense
 * boundary — by then the shell has flushed and the response is committed 200,
 * which is the bug this layout exists to fix. Deleting this file would restore
 * a 200 for unknown vendors while every test about the page body still passed,
 * so the check belongs here, above the boundary.
 */
describe("proof page vendor guard", () => {
	/*
	 * `findPublishedVendor`, not `findVendor`. An UNPUBLISHED vendor resolves to
	 * undefined here exactly as an unknown one does, which is what makes the
	 * two 404s indistinguishable — see the tests further down this file.
	 */
	it("calls notFound() for a vendor that doesn't exist", async () => {
		vi.mocked(findPublishedVendor).mockResolvedValue(undefined);

		await expect(
			ProofLayout({ children: null, params: Promise.resolve({ vendor: "no-such-vendor" }) }),
		).rejects.toThrow("NEXT_NOT_FOUND");

		expect(notFound).toHaveBeenCalled();
	});

	it("renders children for a vendor that does exist", async () => {
		vi.mocked(findPublishedVendor).mockResolvedValue({ slug: "acme", name: "Acme" } as never);

		await expect(
			ProofLayout({ children: null, params: Promise.resolve({ vendor: "acme" }) }),
		).resolves.toBeDefined();

		expect(notFound).not.toHaveBeenCalled();
	});

	it("looks the vendor up by the slug from the route, not anything else", async () => {
		vi.mocked(findPublishedVendor).mockResolvedValue({ slug: "lettertrace", name: "Lettertrace" } as never);

		await ProofLayout({ children: null, params: Promise.resolve({ vendor: "lettertrace" }) });

		expect(findPublishedVendor).toHaveBeenCalledWith("lettertrace");
	});
});
