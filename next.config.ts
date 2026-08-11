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
		];
	},
};

export default nextConfig;
