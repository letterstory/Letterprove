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
			// RFC 8414 fixes this path exactly — a client appends it to the issuer
			// and expects the document there, so it is not ours to name.
			{
				source: "/.well-known/oauth-authorization-server",
				destination: "/api/well-known/oauth-authorization-server",
			},
		];
	},
};

export default nextConfig;
