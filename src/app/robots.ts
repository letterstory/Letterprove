import type { MetadataRoute } from "next";
import { headers } from "next/headers";

/**
 * Crawlers may read everything an agent evaluating a vendor needs: the proof
 * pages, the signed attestations under /attest, the discovery documents under
 * /.well-known, and the docs/keys/verify pages that explain them. Only /api/ is
 * fenced off — it is the collector and tool surface, and the machine proof
 * endpoint there is reachable at its public /proofs path anyway.
 *
 * Until this existed, /robots.txt answered 404 and nothing told a crawler the
 * proof pages exist. The 2026-10-08 AEO stress test found no answer engine
 * surfacing Letterprove or a published vendor unprompted (0 of 36 cold asks),
 * and Perplexity — which reads only its own index — could not see a proof at
 * all. Discovery starts with being crawlable.
 *
 * The origin comes from the request host, as on /proofs/{vendor}, so a preview
 * deploy points at its own sitemap rather than production's.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
	const host = (await headers()).get("host") ?? "localhost";
	const origin = `${host.startsWith("localhost") ? "http" : "https"}://${host}`;

	return {
		rules: { userAgent: "*", allow: "/", disallow: "/api/" },
		sitemap: `${origin}/sitemap.xml`,
	};
}
