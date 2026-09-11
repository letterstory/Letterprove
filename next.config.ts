import type { NextConfig } from "next";

/**
 * `.well-known` cannot be an App Router directory — a leading dot makes the
 * bundler skip it — so the discovery documents live under /api/well-known and
 * are rewritten onto their spec-mandated paths here.
 */
const nextConfig: NextConfig = {
	async rewrites() {
		return [
			{ source: "/.well-known/letterprove.json", destination: "/api/well-known/letterprove" },
			{ source: "/.well-known/letterprove-jwks.json", destination: "/api/well-known/jwks" },
			// There is no RFC 8414 rewrite here anymore. The OAuth server retired
			// with the auth unification (#124/#130) and its discovery route went
			// with it, so the rewrite pointed at nothing and the spec-mandated path
			// answered 404. A rewrite onto a missing destination is worse than no
			// rewrite: it reads as a working surface to anyone scanning this file.
		];
	},
};

export default nextConfig;
