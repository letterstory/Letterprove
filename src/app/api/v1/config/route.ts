import { findVendorByKey } from "@/lib/fixtures/vendors";
import { configJson, notFound } from "@/lib/http";
import { CURRENT_CONFIG_VERSION } from "@/lib/telemetry/events";

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
	const key = new URL(request.url).searchParams.get("k");
	const vendor = key ? findVendorByKey(key) : undefined;
	if (!vendor) return notFound("unknown key");

	return configJson({
		cfg: CURRENT_CONFIG_VERSION,
		signals: [],
	});
}
