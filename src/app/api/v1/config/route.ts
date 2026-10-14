import { findVendorByKey } from "@/lib/fixtures/vendors";
import { configJson, notFound, rateLimited } from "@/lib/http";
import { oauthClientIp, oauthRateLimit } from "@/lib/oauth/ratelimit";
import { CURRENT_CONFIG_VERSION } from "@/lib/telemetry/events";
import { recordConfigPing } from "@/lib/telemetry/ping";
import { collectorModules, recordScriptSeen, scriptNameOf } from "@/lib/vendors/script";
import { autoCheckUrl, scheduleSiteAutoVerify } from "@/lib/vendors/site-proof";

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
 * `modules.proofs` says whether attest.js collects sign-ins
 * (src/lib/vendors/script.ts). Letterprove is attestation only since
 * 2026-10-14: no agent-visit or visitor-identification fields (those are the
 * Visitors product, served by the Letterstory app).
 *
 * `s` names the script asking. `attest` (or none) is attest.js; `s=visit`
 * from an old cached visit.js is tolerated and answered the same way.
 *
 * Site proof (lib/vendors/site-proof.ts): when attest.js asks from a page on
 * the vendor's domain and the vendor has neither DNS nor site proof yet, we
 * fetch that page (the Referer, else the origin's root) after responding, at
 * most every ten minutes. The ping itself proves nothing; the fetch does.
 */
export async function GET(request: Request) {
	if (!(await oauthRateLimit(`config:ip:${oauthClientIp(request)}`, 60, CONFIG_IP_LIMIT_PER_MINUTE))) {
		return rateLimited();
	}

	const params = new URL(request.url).searchParams;
	const key = params.get("k");
	const vendor = key ? await findVendorByKey(key) : undefined;
	if (!vendor) return notFound("unknown key");

	const [, , modules] = await Promise.all([
		recordConfigPing(vendor.slug),
		vendor.id ? recordScriptSeen(vendor.id, scriptNameOf(params.get("s"))) : null,
		vendor.id ? collectorModules(vendor.id) : { proofs: true },
	]);

	const script = scriptNameOf(params.get("s"));
	if (vendor.id && script === "attest" && !vendor.domainVerified && !vendor.siteVerifiedAt) {
		const page = autoCheckUrl(request.headers.get("origin"), request.headers.get("referer"), vendor.domain);
		if (page) scheduleSiteAutoVerify(vendor.id, page);
	}

	return configJson({
		cfg: CURRENT_CONFIG_VERSION,
		signals: [],
		modules: { proofs: modules.proofs },
	});
}
