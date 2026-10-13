import { findVendorByKey } from "@/lib/fixtures/vendors";
import { configJson, notFound, rateLimited } from "@/lib/http";
import { oauthClientIp, oauthRateLimit } from "@/lib/oauth/ratelimit";
import { CURRENT_CONFIG_VERSION } from "@/lib/telemetry/events";
import { recordConfigPing } from "@/lib/telemetry/ping";
import { visitorPixel } from "@/lib/vendors/visitors";
import { collectorModules } from "@/lib/vendors/script";

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
 *
 * `visitors` is present only when the vendor turned visitor identification on
 * and its domain is registered with Maverick: attest.js then loads the
 * Maverick pixel (src/lib/vendors/visitors.ts). Absent otherwise, so a vendor
 * who never opted in ships exactly the script they always did.
 *
 * `modules` says which parts of the one script run (src/lib/vendors/script.ts):
 * sign-ins for the proof, agent-visit beacons, and the visitor pixel. An older
 * cached response without it means everything that was on stays on.
 */
export async function GET(request: Request) {
	if (!(await oauthRateLimit(`config:ip:${oauthClientIp(request)}`, 60, CONFIG_IP_LIMIT_PER_MINUTE))) {
		return rateLimited();
	}

	const key = new URL(request.url).searchParams.get("k");
	const vendor = key ? await findVendorByKey(key) : undefined;
	if (!vendor) return notFound("unknown key");

	const [, pixel, modules] = await Promise.all([
		recordConfigPing(vendor.slug),
		vendor.id ? visitorPixel(vendor.id) : null,
		vendor.id ? collectorModules(vendor.id) : { proofs: true, agent_visitors: true },
	]);

	return configJson({
		cfg: CURRENT_CONFIG_VERSION,
		signals: [],
		modules: { proofs: modules.proofs, agent_visitors: modules.agent_visitors, human_visitors: Boolean(pixel) },
		...(pixel ? { visitors: { pixel } } : {}),
	});
}
