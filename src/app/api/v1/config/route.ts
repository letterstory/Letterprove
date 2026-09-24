import { findVendorByKey } from "@/lib/fixtures/vendors";
import { configJson, notFound, rateLimited } from "@/lib/http";
import { oauthClientIp, oauthRateLimit } from "@/lib/oauth/ratelimit";
import { CURRENT_CONFIG_VERSION } from "@/lib/telemetry/events";
import { recordConfigPing } from "@/lib/telemetry/ping";

/** Per source IP — same backstop as POST /v1/observe (see that route's comment); unauthenticated and unmetered otherwise, so a burst against every key costs nothing without this. */
const CONFIG_IP_LIMIT_PER_MINUTE = 300;

/**
 * `GET /v1/config` — see README § Configuration.
 *
 * Fails closed: an unknown key gets a `404`, not a guessed config, and the
 * response carries no `cache-control` so a vendor who fixes a mistyped key
 * doesn't have to wait out a cached failure. `signals` ships empty — reserved
 * for phase-2 named/feature events — purely so that phase doesn't force a
 * breaking response-shape change later.
 */
export async function GET(request: Request) {
	if (!(await oauthRateLimit(`config:ip:${oauthClientIp(request)}`, 60, CONFIG_IP_LIMIT_PER_MINUTE))) {
		return rateLimited();
	}

	const key = new URL(request.url).searchParams.get("k");
	const vendor = key ? await findVendorByKey(key) : undefined;
	if (!vendor) return notFound("unknown key");

	await recordConfigPing(vendor.slug);

	return configJson({
		cfg: CURRENT_CONFIG_VERSION,
		signals: [],
	});
}
