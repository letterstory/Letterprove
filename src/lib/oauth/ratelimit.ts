import { dbClient } from "@/lib/db/client";

/**
 * Fixed-window rate limit backed by the oauth_rate_touch() Postgres function
 * (see 20260817120000_oauth_authorization_server.sql), so the budget holds
 * across serverless instances — an in-memory counter is per-instance and
 * therefore no limit at all on an auth endpoint.
 *
 * Fails OPEN on infra error, and when no datastore is configured at all: a
 * transient DB blip should not lock everyone out of login, and the operations
 * it guards (PKCE, single-use codes, client authentication) are each safe on
 * their own without the backstop. Same posture as the collector, which accepts
 * rather than fails closed when storage is missing (see src/lib/db/client.ts).
 */
export async function oauthRateLimit(bucket: string, windowSeconds: number, limit: number): Promise<boolean> {
	const db = dbClient();
	if (!db) return true;

	const { data, error } = await db.rpc("oauth_rate_touch", {
		p_bucket: bucket,
		p_window_seconds: windowSeconds,
		p_limit: limit,
	});
	if (error) return true;
	return data === true;
}

/**
 * The caller's IP for bucketing. Header-derived and therefore spoofable by
 * anyone who can reach the app directly, which is acceptable for a fixed-window
 * backstop but is why nothing security-critical keys off it. Not logged — the
 * repo keeps the fact and drops the identifier (see src/lib/access/log.ts).
 */
export function oauthClientIp(request: Request): string {
	const forwardedFor = request.headers.get("x-forwarded-for");
	if (forwardedFor) return forwardedFor.split(",")[0].trim();
	return request.headers.get("x-real-ip") || "unknown";
}
