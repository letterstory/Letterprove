import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { publishedVendors } from "@/lib/fixtures/vendors";

/**
 * Every published vendor's proof page, plus the pages that explain how to
 * check one. Built per request (reading `headers()` makes it dynamic), so a
 * vendor appears the moment it is published and disappears the moment it is
 * unpublished — `publishedVendors()` is the same gate every public proof route
 * resolves through, so the sitemap can never list a private vendor.
 *
 * Only the human-readable /proofs/{vendor} page is listed, not the JSON under
 * /attest: the page carries the JSON-LD and links to the attestations, and an
 * index wants the page. Proof pages change every hour as snapshots are signed,
 * hence `hourly`.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	const host = (await headers()).get("host") ?? "localhost";
	const origin = `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
	const vendors = await publishedVendors();

	return [
		...vendors.map((v) => ({
			url: `${origin}/proofs/${v.slug}`,
			changeFrequency: "hourly" as const,
			priority: 1,
		})),
		...["/verify", "/keys", "/docs"].map((path) => ({
			url: `${origin}${path}`,
			changeFrequency: "weekly" as const,
			priority: 0.5,
		})),
	];
}
